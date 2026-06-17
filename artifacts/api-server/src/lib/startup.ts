import { approvalGate }           from "./approvalGate";
import { backfillStructuredReflections, closeOpenTrade, resolveExitReason } from "./tradeMemoryLib";
import { openPosition }            from "../brokers/etoro";
import {
  openPosition    as bybitOpen,
  setOneWayMode   as bybitSetOneWayMode,
  getPositions    as bybitGetPositions,
  getOrders       as bybitGetOrders,
  setStopLoss     as bybitSetStopLoss,
  setTakeProfit   as bybitSetTakeProfit,
  getClosedPnl    as bybitGetClosedPnl,
  ensurePartialOrder    as bybitEnsurePartialOrder,
  getKlines,
  getTicker,
  type BybitKline,
} from "../brokers/bybit";
import { openPosition as okxOpen, testConnection, setPositionMode } from "../brokers/okx";
import { openPositionPaper }       from "../brokers/okxPaper";
import { sendApprovalRequest, sendAlert } from "../notifications/telegram";
import { syncAllHoldingsToDB }     from "./aiResponder";
import { syncTotalCapitalToDB }    from "./brokerBalance";
import { db, botStateTable, tradeLogTable, type PositionMeta, type PendingLimitFill } from "@workspace/db";
import { and, desc, eq, isNull }   from "drizzle-orm";

export let okxPaperMode = false;

export const pendingLimitFills = new Map<string, PendingLimitFill>();

async function persistPendingLimitFillsToDB(): Promise<void> {
  const obj: Record<string, PendingLimitFill> = {};
  for (const [sym, v] of pendingLimitFills) obj[sym] = v;
  await db.update(botStateTable)
    .set({ pendingLimitFills: Object.keys(obj).length ? obj : null, lastUpdated: new Date() })
    .where(eq(botStateTable.id, 1))
    .catch(e => console.warn("[startup] pendingLimitFills DB write failed:", (e as Error).message));
}

export async function removePendingLimitFill(symbol: string): Promise<void> {
  pendingLimitFills.delete(symbol);
  await persistPendingLimitFillsToDB();
}

// ── ATR (Wilder's smoothing) ──────────────────────────────────────────────────
function calcATR(klines: BybitKline[], period = 14): number {
  if (klines.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i]!.high, l = klines[i]!.low, pc = klines[i - 1]!.close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]!) / period;
  return atr;
}

// ── Save metadata helper ──────────────────────────────────────────────────────
async function storePositionMeta(symbol: string, meta: PositionMeta): Promise<void> {
  const [row] = await db.select({ positionMetadata: botStateTable.positionMetadata })
    .from(botStateTable).limit(1);
  const existing = (row?.positionMetadata ?? {}) as Record<string, PositionMeta>;
  existing[symbol] = {
    entrySource:    existing[symbol]?.entrySource,
    trailingActive: false,   // never inherit — new positions always start clean
    ...meta,
  };
  await db.update(botStateTable)
    .set({ positionMetadata: existing, lastUpdated: new Date() })
    .where(eq(botStateTable.id, 1));
}

// ── ATR-based SL/TP after every position open ────────────────────────────────
export async function applyAtrSlTp(
  symbol:      string,
  direction:   "long" | "short",
  entryPrice:  number,
  positionIdx: number,
  originalQty: number,
): Promise<void> {
  const klines = await getKlines(symbol, "240", 28).catch(() => [] as BybitKline[]);
  const atr    = calcATR(klines, 14);

  if (atr === 0) {
    console.warn(`[startup] ATR=0 for ${symbol} — skipping SL/TP`);
    return;
  }

  const mult   = direction === "long" ? 1 : -1;
  const atrSl  = entryPrice - mult * atr * 1.5;
  const atrTp1 = entryPrice + mult * atr * 1.0;
  const atrTp2 = entryPrice + mult * atr * 2.0;

  const livePrice = await getTicker(symbol).then(t => t.lastPrice).catch(() => entryPrice);
  const slOnside  = (n: number) => (direction === "long" && n < livePrice) || (direction === "short" && n > livePrice);

  // Priority 1: Claude's planned SL/TP from trade_log — never override with ATR if Claude's values exist
  const dbRows = await db.select({ sl: tradeLogTable.sl, tp1: tradeLogTable.tp1, tp2: tradeLogTable.tp2 })
    .from(tradeLogTable)
    .where(and(eq(tradeLogTable.symbol, symbol), eq(tradeLogTable.broker, "bybit"), isNull(tradeLogTable.exitAt)))
    .orderBy(desc(tradeLogTable.entryAt))
    .limit(1)
    .catch(() => [] as Array<{ sl: unknown; tp1: unknown; tp2: unknown }>);

  const dbSl  = dbRows[0]?.sl  ? parseFloat(String(dbRows[0].sl))  : 0;
  const dbTp1 = dbRows[0]?.tp1 ? parseFloat(String(dbRows[0].tp1)) : 0;
  const dbTp2 = dbRows[0]?.tp2 ? parseFloat(String(dbRows[0].tp2)) : 0;

  let sl: number;
  if (dbSl > 0 && slOnside(dbSl)) {
    sl = dbSl;
    console.log(`[startup] ${symbol} SL priority: trade_log $${sl.toFixed(4)} (skipping ATR override)`);
  } else {
    // ATR fallback — apply defensive checks
    sl = atrSl;
    if (direction === "long" && sl > entryPrice) sl = entryPrice - atr * 1.5;
    if (direction === "short" && sl < entryPrice) sl = entryPrice + atr * 1.5;
    const maxSlDist = entryPrice * 0.40;
    if (Math.abs(sl - entryPrice) > maxSlDist)
      sl = direction === "long" ? entryPrice - maxSlDist : entryPrice + maxSlDist;
  }

  // TP for exchange: use Claude's TP2 (full-mode close target) if available; else ATR TP1
  // TP1 for metadata: used by software polling (checkPartialExits) — use Claude's TP1 if available
  const tp1        = dbTp1 > 0 ? dbTp1 : atrTp1;
  const tp2        = dbTp2 > 0 ? dbTp2 : atrTp2;
  const exchangeTp = dbTp2 > 0 ? dbTp2 : atrTp1; // Full-mode TP on exchange = TP2 if known

  await Promise.allSettled([
    slOnside(sl) ? bybitSetStopLoss(symbol, sl, positionIdx) : Promise.resolve(),
    bybitSetTakeProfit(symbol, exchangeTp, positionIdx),
  ]);

  // Caller pre-check: skip if TP1 already fired during downtime (tp1Executed flag or ≥15% size shrink).
  // ensurePartialOrder handles the exchange-side idempotency check internally (fail-closed).
  const [_guardRow] = await db.select({ positionMetadata: botStateTable.positionMetadata })
    .from(botStateTable).limit(1).catch(() => [null]);
  const _existingPm = ((_guardRow?.positionMetadata ?? {}) as Record<string, PositionMeta>)[symbol];
  const _tp1AlreadyFired = (_existingPm?.tp1Executed ?? false) ||
    Boolean(_existingPm?.originalQty && _existingPm.originalQty > 0 && originalQty < _existingPm.originalQty * 0.85);
  if (!_tp1AlreadyFired) {
    const _tp1r = await bybitEnsurePartialOrder(symbol, "PartialTakeProfit", tp1, originalQty, positionIdx);
    console.log(`[startup] applyAtrSlTp ${symbol} TP1: ${_tp1r}`);
  } else {
    console.log(`[startup] applyAtrSlTp ${symbol} TP1 skipped — tp1AlreadyFired=true`);
  }

  await storePositionMeta(symbol, {
    originalQty,
    entryPrice,
    sl,
    atr,
    tp1,
    tp2,
    openedAt: Date.now(),
  }).catch(e => console.warn(`[startup] storePositionMeta ${symbol}:`, e.message));

  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  console.log(`[startup] ATR SL/TP for ${symbol} ${direction}: ATR=${atr.toFixed(4)} SL=$${fmt(sl)} TP1=$${fmt(tp1)} TP2=$${fmt(tp2)}`);

  await sendAlert([
    `🛡️ <b>ATR Stop set — ${symbol} ${direction}</b>`,
    `Entry: $${fmt(entryPrice)}  ATR: $${fmt(atr)}`,
    `SL:  $${fmt(sl)}`,
    `TP1: $${fmt(tp1)}`,
    `TP2: $${fmt(tp2)} (partial-exit target)`,
  ].join("\n")).catch(() => {});
}

async function logPositionMetadata(): Promise<void> {
  const [row] = await db.select({ positionMetadata: botStateTable.positionMetadata })
    .from(botStateTable).limit(1).catch(() => [{ positionMetadata: {} }]);
  console.log("[startup] Position metadata:", JSON.stringify(row?.positionMetadata ?? {}, null, 2));
}

async function recoverPendingLimitFills(): Promise<void> {
  const [row] = await db.select({
    pendingLimitFills: botStateTable.pendingLimitFills,
    positionMetadata:  botStateTable.positionMetadata,
  }).from(botStateTable).limit(1).catch(() => [null]);

  const dbFills = (row?.pendingLimitFills ?? {}) as Record<string, PendingLimitFill>;
  if (!Object.keys(dbFills).length) return;

  const livePositions = await bybitGetPositions().catch(() => []);
  const liveMap = new Map(livePositions.map(p => [p.symbol, p]));
  const openOrders  = await bybitGetOrders().catch(() => [] as Awaited<ReturnType<typeof bybitGetOrders>>);
  const openOrderSymbols = new Set(openOrders.map(o => o.symbol));
  const posMeta = (row?.positionMetadata ?? {}) as Record<string, PositionMeta>;
  const toKeep: Record<string, PendingLimitFill> = {};

  for (const [symbol, fill] of Object.entries(dbFills)) {
    const livePos = liveMap.get(symbol);
    if (!livePos) {
      if (openOrderSymbols.has(symbol)) {
        console.log(`[startup] pendingLimitFill ${symbol} — no position yet but limit order still open, keeping`);
        pendingLimitFills.set(symbol, fill);
        toKeep[symbol] = fill;
      } else {
        console.log(`[startup] pendingLimitFill ${symbol} — no live position and no open order, removing`);
      }
      continue;
    }
    pendingLimitFills.set(symbol, fill);
    toKeep[symbol] = fill;
    const tp1Executed = (posMeta[symbol]?.tp1Executed ?? false);
    // Fix 2: guard against re-placing TP1 after it already fired during bot downtime.
    // If position has shrunk ≥15% since fill, TP1 already executed — mark and skip.
    const originalFillQty = fill.qty ?? 0;
    if (!tp1Executed && originalFillQty > 0 && livePos.size < originalFillQty * 0.85) {
      console.log(`[startup] ${symbol} TP1 already fired (live ${livePos.size} < ${originalFillQty} × 0.85) — marking tp1Executed, skipping`);
      const [_pr] = await db.select({ positionMetadata: botStateTable.positionMetadata })
        .from(botStateTable).limit(1).catch(() => [null]);
      const _pm = (_pr?.positionMetadata ?? {}) as Record<string, PositionMeta>;
      _pm[symbol] = { ...(_pm[symbol] ?? {} as PositionMeta), tp1Executed: true };
      await db.update(botStateTable)
        .set({ positionMetadata: _pm, lastUpdated: new Date() })
        .where(eq(botStateTable.id, 1)).catch(() => {});
    } else {
      // Resolve TP1: use signal value if present, otherwise fall back to positionMeta ATR value.
      // The ATR fallback path handles positions whose signal lacked tp1 (e.g. HYPE $73.4).
      const resolvedTp1 = (fill.tp1 && fill.tp1 > 0) ? fill.tp1 : (posMeta[symbol]?.tp1 ?? 0);
      if (!tp1Executed && resolvedTp1 > 0) {
        const r = await bybitEnsurePartialOrder(symbol, "PartialTakeProfit", resolvedTp1, livePos.size, fill.positionIdx, fill.tp1ClosePercent);
        console.log(`[startup] ${symbol} TP1 recovery: ${r} ($${resolvedTp1})`);
      }
    }
    if (fill.tp2 && fill.tp2 > 0 && (fill.tp2ClosePercent ?? 100) < 100) {
      const r = await bybitEnsurePartialOrder(symbol, "PartialTakeProfit", fill.tp2, livePos.size, fill.positionIdx, fill.tp2ClosePercent);
      console.log(`[startup] ${symbol} TP2 recovery: ${r} ($${fill.tp2})`);
    }
  }

  await db.update(botStateTable)
    .set({ pendingLimitFills: Object.keys(toKeep).length ? toKeep : null, lastUpdated: new Date() })
    .where(eq(botStateTable.id, 1))
    .catch(e => console.warn("[startup] pendingLimitFills recovery update failed:", (e as Error).message));

  console.log(`[startup] pendingLimitFills recovered: ${Object.keys(toKeep).length} active`);
}

export async function initBrokers(): Promise<void> {
  approvalGate.registerExecutor("etoro", async (p) => {
    const symbol = p.symbol.replace(/[-/]?(USDT|USDC|USD)$/i, "");
    const result = await openPosition(symbol, p.amountUsd, p.side === "buy");
    return { orderId: result.positionId };
  });

  await bybitSetOneWayMode().catch(e => console.warn("[startup] Bybit set-one-way-mode failed:", e.message));

  approvalGate.registerExecutor("bybit", async (p) => {
    const leverage = 10;
    const bSide    = p.side === "buy" ? "Buy" : "Sell";
    const isShort  = bSide === "Sell";

    // Treat 0 as missing — Claude schema default can produce 0
    let sl = (p.stopLossPrice  && p.stopLossPrice  > 0) ? p.stopLossPrice  : undefined;
    let tp = (p.takeProfitPrice && p.takeProfitPrice > 0) ? p.takeProfitPrice : undefined;

    // Plausibility: SL/TP must be on the correct side of entry
    // We don't have entryPrice yet, so use currentPrice as proxy if available
    const refPrice = p.currentPrice ?? 0;
    if (refPrice > 0 && sl) {
      if (!isShort && sl >= refPrice) {
        console.warn(`[startup] ${p.symbol} Claude SL $${sl} >= entry ~$${refPrice} for LONG — ATR fallback`);
        sl = undefined;
      }
      if (isShort && sl <= refPrice) {
        console.warn(`[startup] ${p.symbol} Claude SL $${sl} <= entry ~$${refPrice} for SHORT — ATR fallback`);
        sl = undefined;
      }
    }
    if (refPrice > 0 && tp) {
      if (!isShort && tp <= refPrice) {
        console.warn(`[startup] ${p.symbol} Claude TP $${tp} <= entry ~$${refPrice} for LONG — ATR fallback`);
        tp = undefined;
      }
      if (isShort && tp >= refPrice) {
        console.warn(`[startup] ${p.symbol} Claude TP $${tp} >= entry ~$${refPrice} for SHORT — ATR fallback`);
        tp = undefined;
      }
    }

    console.log(`[startup] Opening position with SL/TP: ${p.symbol} ${bSide}`, { sl: sl ?? "none", tp: tp ?? "none" });

    const tp1             = (p.tp1Price           && p.tp1Price   > 0) ? p.tp1Price   : undefined;
    const limitPrice      = (p.limitPrice         && p.limitPrice > 0) ? p.limitPrice : undefined;
    const tp1ClosePercent = p.tp1ClosePercent ?? undefined;
    const tp2ClosePercent = p.tp2ClosePercent ?? undefined;
    const result = await bybitOpen(p.symbol, bSide, p.amountUsd * leverage, leverage, {
      stopLoss:         sl,
      takeProfit:       tp,
      tp1:              tp1,
      limitPrice:       limitPrice,
      tp1ClosePercent,
      tp2ClosePercent,
    });

    if (result.isLimitOrder) {
      // Position doesn't exist yet — defer SL/TP and metadata to fill detection in posMonitor
      const fillData: PendingLimitFill = {
        sl:              sl,
        tp1:             tp1 ?? undefined,
        tp2:             tp ?? undefined,
        direction:       isShort ? "short" : "long",
        qty:             result.qty,
        positionIdx:     result.positionIdx,
        tp1ClosePercent,
        tp2ClosePercent,
      };
      pendingLimitFills.set(p.symbol, fillData);
      persistPendingLimitFillsToDB().catch(() => {});
      console.log(`[startup] ${p.symbol} limit order pending — SL/TP deferred to fill detection`);
    } else {
      // Market order — position exists, apply SL/TP immediately
      if (!sl || !tp) {
        console.log(`[startup] ${p.symbol} missing Claude SL/TP — applying ATR fallback`);
        applyAtrSlTp(p.symbol, isShort ? "short" : "long", result.entryPrice, result.positionIdx, result.qty)
          .catch(e2 => console.warn(`[startup] applyAtrSlTp ${p.symbol}:`, e2.message));
      } else {
        storePositionMeta(p.symbol, {
          originalQty:     result.qty,
          entryPrice:      result.entryPrice,
          sl,
          tp1:             tp1 ?? tp,
          tp2:             tp,
          atr:             0,
          openedAt:        Date.now(),
          tp1ClosePercent,
          tp2ClosePercent,
        }).catch(e => console.warn(`[startup] storePositionMeta ${p.symbol}:`, e.message));
      }
    }

    return { orderId: result.orderId, actualMarginUsd: result.actualMarginUsd };
  });

  // Probe OKX credentials; fall back to paper trading if keys are invalid
  const { ok } = await testConnection().catch(() => ({ ok: false }));
  if (ok) {
    await setPositionMode("long_short_mode").catch(e =>
      console.warn("[startup] OKX set-position-mode failed:", e.message)
    );
    approvalGate.registerExecutor("okx", async (p) => {
      const result = await okxOpen(p.symbol, p.side, p.amountUsd);
      return { orderId: result.orderId };
    });
    console.log("[startup] OKX: live API keys verified ✅");
  } else {
    okxPaperMode = true;
    approvalGate.registerExecutor("okx", async (p) => {
      const result = await openPositionPaper(p.symbol, p.side, p.amountUsd);
      return { orderId: result.orderId };
    });
    console.log("[startup] OKX: keys rejected — paper trading mode activated 📄");
  }

  approvalGate.registerNotifier(sendApprovalRequest);

  // Sync live broker positions and capital balance into DB
  syncAllHoldingsToDB().catch(e => console.error("[startup] Holdings sync failed:", e));
  syncTotalCapitalToDB().catch(e => console.error("[startup] Capital sync failed:", e));

  // Set SL/TP for any existing positions that don't have them
  setSlTpForExistingPositions().catch(e => console.error("[startup] SL/TP setup failed:", e));

  // Restore pending limit fills from DB — sets TP1 partial on positions that filled across a restart
  recoverPendingLimitFills().catch(e => console.error("[startup] pendingLimitFills recovery failed:", e));

  // Always log current position metadata for debugging
  logPositionMetadata().catch(() => {});

  // Backfill any closed trades missing complete reflections (non-blocking, rate-limited)
  backfillStructuredReflections(60)
    .catch(e => console.error("[startup] backfill failed:", e));

  // Reconcile any positions closed on Bybit while bot was down
  reconcileClosedPositions()
    .catch(e => console.error("[startup] reconcile failed:", e));

  console.log("[startup] Broker executors registered: etoro, bybit, okx");
  console.log("[startup] Telegram notifier registered");
}

async function reconcileClosedPositions(): Promise<void> {
  const openInDb = await db.select()
    .from(tradeLogTable)
    .where(isNull(tradeLogTable.exitAt))
    .catch(() => [] as typeof tradeLogTable.$inferSelect[]);

  const bybitOpen = openInDb.filter(t => t.broker === "bybit");
  if (!bybitOpen.length) return;

  // Load pending limit fills from DB — don't reconcile-close a row while its limit order is still open
  const [stateRow] = await db.select({ pendingLimitFills: botStateTable.pendingLimitFills })
    .from(botStateTable).limit(1).catch(() => [null]);
  const pendingSymbols = new Set(Object.keys(stateRow?.pendingLimitFills ?? {}));

  const livePositions = await bybitGetPositions().catch(() => []);
  const liveSymbols   = new Set(livePositions.map(p => p.symbol));

  for (const trade of bybitOpen) {
    if (liveSymbols.has(trade.symbol)) continue;

    // Pending limit order — position may not have opened yet; reconciler must not touch it
    if (pendingSymbols.has(trade.symbol)) {
      console.log(`[reconcile] ${trade.symbol} — pending limit fill exists, skipping reconcile`);
      continue;
    }

    console.log(`[reconcile] ${trade.symbol} open in DB but not on Bybit — fetching closedPnl`);
    // Group all close records for this logical trade by avgEntryPrice proximity + time window.
    // Bybit's closed-pnl endpoint has no position ID — each partial close is an independent record.
    // avgEntryPrice is consistent across all partials of one position; the 4h time window prevents
    // merging an unrelated trade re-opened at a similar price within the same session.
    const entryPx = parseFloat(trade.entryPrice ?? "0");
    const startMs = trade.entryAt ? Math.max(0, trade.entryAt.getTime() - 4 * 60 * 60 * 1000) : undefined;
    const closed   = await bybitGetClosedPnl(50, startMs, trade.symbol).catch(() => []);
    const entryAnchorMs = trade.entryAt ? trade.entryAt.getTime() : 0;
    const matching = closed
      .filter(c => entryPx <= 0 || Math.abs(c.avgEntryPrice / entryPx - 1) < 0.06)
      .filter(c => c.closedAt >= entryAnchorMs - 10_000)
      .sort((a, b) => a.closedAt - b.closedAt);
    const totalPnl = matching.reduce((s, c) => s + c.closedPnl, 0);
    const record   = matching[matching.length - 1]; // final close = exit price

    if (record && matching.length > 0) {
      const totalAmt  = matching.reduce((s, c) => s + c.closedSize * c.avgEntryPrice, 0);
      const exitReason = await resolveExitReason({
        symbol:  trade.symbol,
        orderId: record.orderId,
        entryAt: trade.entryAt ?? undefined,
        exitAt:  new Date(record.closedAt), // actual close time, not bot-restart time
      }).catch(() => undefined);
      console.log(`[reconcile] ${trade.symbol} exit reason resolved: ${exitReason ?? "unknown"}`);
      await closeOpenTrade({
        symbol:             trade.symbol,
        broker:             "bybit",
        exitPrice:          record.avgExitPrice,
        amountUsd:          totalAmt,
        pnlOverride:        totalPnl,
        entryPriceOverride: record.avgEntryPrice,
        exitReason,
      }).catch(e => console.warn(`[reconcile] closeOpenTrade ${trade.symbol}:`, (e as Error).message));
      console.log(`[reconcile] ${trade.symbol} closed — exit $${record.avgExitPrice} pnl $${totalPnl.toFixed(2)} (${matching.length} close record${matching.length > 1 ? "s" : ""})`);
      await sendAlert?.([
        `🔄 <b>Reconciled: ${trade.symbol}</b>`,
        `Was open in DB but closed on Bybit`,
        `Exit: $${record.avgExitPrice.toFixed(4)} | P/L: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
      ].join("\n")).catch(() => {});
    } else {
      console.warn(`[reconcile] ${trade.symbol} — no closedPnl found on Bybit`);
    }
  }

  console.log("[reconcile] Startup reconciliation complete");
}

async function setSlTpForExistingPositions(): Promise<void> {
  const positions = await bybitGetPositions().catch(() => []);
  if (!positions.length) return;

  // Load existing metadata to skip already-tracked positions
  const [stateRow] = await db.select({ positionMetadata: botStateTable.positionMetadata })
    .from(botStateTable).limit(1).catch(() => [{ positionMetadata: {} }]);
  const existingMeta = (stateRow?.positionMetadata ?? {}) as Record<string, PositionMeta>;

  // Purge metadata for symbols no longer on Bybit (accumulated stale entries)
  const liveSymbols = new Set(positions.map(p => p.symbol));
  const staleKeys   = Object.keys(existingMeta).filter(k => !liveSymbols.has(k));
  if (staleKeys.length) {
    staleKeys.forEach(k => delete existingMeta[k]);
    await db.update(botStateTable)
      .set({ positionMetadata: existingMeta, lastUpdated: new Date() })
      .where(eq(botStateTable.id, 1)).catch(() => {});
    console.log(`[startup] Cleared stale metadata for: ${staleKeys.join(", ")}`);
  }

  for (const pos of positions) {
    const direction = pos.side === "Buy" ? "long" : "short" as "long" | "short";
    const mult = direction === "long" ? 1 : -1;
    const pm   = existingMeta[pos.symbol];

    // Live price fetched once — used for SL validity checks across all priorities
    const livePrice = await getTicker(pos.symbol).then(t => t.lastPrice).catch(() => 0);
    const ref = livePrice > 0 ? livePrice : pos.entryPrice;

    // ── Priority 1: Claude's planned SL from trade_log ──────────────────────
    // Skip if trailing SL is active — exchange is authoritative for the current trailing level
    if (!pm?.trailingActive) {
      const dbRows = await db.select({ sl: tradeLogTable.sl, tp1: tradeLogTable.tp1, tp2: tradeLogTable.tp2 })
        .from(tradeLogTable)
        .where(and(
          eq(tradeLogTable.symbol,  pos.symbol),
          eq(tradeLogTable.broker,  "bybit"),
          isNull(tradeLogTable.exitAt),
        ))
        .orderBy(desc(tradeLogTable.entryAt))
        .limit(1)
        .catch(() => [] as { sl: string | null; tp1: string | null; tp2: string | null }[]);

      const claudeSl = dbRows[0]?.sl ? parseFloat(dbRows[0].sl) : null;
      const claudeSlValid = claudeSl != null && claudeSl > 0 &&
        (direction === "long" ? claudeSl < ref : claudeSl > ref);

      if (claudeSlValid) {
        // Take the more protective SL: trade_log (Claude's plan) vs positionMetadata (in-session ratchet)
        // Longs: higher SL is more protective. Shorts: lower SL is more protective.
        const metaSl      = pm?.sl ?? 0;
        const metaSlValid = metaSl > 0 && (direction === "long" ? metaSl < ref : metaSl > ref);
        const chosenSl    = metaSlValid
          ? (direction === "long" ? Math.max(claudeSl, metaSl) : Math.min(claudeSl, metaSl))
          : claudeSl;
        const slSource    = chosenSl !== claudeSl ? "positionMeta ratchet" : "trade_log";

        await bybitSetStopLoss(pos.symbol, chosenSl, pos.positionIdx)
          .catch(e => console.warn(`[startup] setStopLoss ${pos.symbol}:`, e.message));
        await storePositionMeta(pos.symbol, {
          originalQty: pm?.originalQty ?? pos.size,
          entryPrice:  pos.entryPrice,
          sl:          chosenSl,
          atr:         pm?.atr ?? 0,
          tp1:         pm?.tp1 ?? (dbRows[0]?.tp1 ? parseFloat(dbRows[0].tp1!) : pos.entryPrice + mult * 0.01),
          tp2:         pm?.tp2 ?? (dbRows[0]?.tp2 ? parseFloat(dbRows[0].tp2!) : pos.entryPrice + mult * 0.02),
          openedAt:    pm?.openedAt ?? (pos.openTime ?? Date.now()),
        }).catch(e => console.warn(`[startup] storePositionMeta ${pos.symbol}:`, e.message));
        console.log(`[startup] ${pos.symbol} — SL $${chosenSl.toFixed(4)} (${slSource})`);
        continue;
      }
    }

    // ── Priority 2: Exchange already has a valid SL — preserve it ────────────
    const exchangeSl = pos.stopLoss ?? 0;
    const exchangeSlValid = exchangeSl > 0 &&
      (direction === "long" ? exchangeSl < ref : exchangeSl > ref);

    if (exchangeSlValid) {
      const note = pm?.trailingActive
        ? `trailing SL active (SL=$${exchangeSl.toFixed(4)}) preserving`
        : `exchange SL preserved: $${exchangeSl.toFixed(4)}`;
      console.log(`[startup] ${pos.symbol} — ${note}`);
      await storePositionMeta(pos.symbol, {
        originalQty: pm?.originalQty ?? pos.size,
        entryPrice:  pos.entryPrice,
        sl:          exchangeSl,
        atr:         pm?.atr ?? 0,
        tp1:         pm?.tp1 ?? pos.entryPrice + mult * 0.01,
        tp2:         pm?.tp2 ?? pos.entryPrice + mult * 0.02,
        openedAt:    pm?.openedAt ?? (pos.openTime ?? Date.now()),
      }).catch(e => console.warn(`[startup] storePositionMeta ${pos.symbol}:`, e.message));
      continue;
    }

    // ── Priority 3: ATR fallback — only when no SL exists anywhere ───────────
    const klines = await getKlines(pos.symbol, "240", 28).catch(() => [] as BybitKline[]);
    const atr    = calcATR(klines, 14);

    if (atr === 0) {
      console.warn(`[startup] ATR=0 for ${pos.symbol} — skipping`);
      continue;
    }

    let sl   = pos.entryPrice - mult * atr * 1.5;
    const tp1 = pos.entryPrice + mult * atr * 1.0;
    const tp2 = pos.entryPrice + mult * atr * 2.0;

    if (direction === "long" && sl > pos.entryPrice) {
      console.error(`[startup] SL above entry for long — recalculating: SL=$${sl.toFixed(4)} entry=$${pos.entryPrice.toFixed(4)}`);
      sl = pos.entryPrice - atr * 1.5;
    }
    if (direction === "short" && sl < pos.entryPrice) {
      console.error(`[startup] SL below entry for short — recalculating: SL=$${sl.toFixed(4)} entry=$${pos.entryPrice.toFixed(4)}`);
      sl = pos.entryPrice + atr * 1.5;
    }

    const maxSlDist = pos.entryPrice * 0.40;
    if (Math.abs(sl - pos.entryPrice) > maxSlDist)
      sl = direction === "long" ? pos.entryPrice - maxSlDist : pos.entryPrice + maxSlDist;

    const slValid = livePrice === 0 ||
      (direction === "long" ? sl < livePrice : sl > livePrice);

    if (!slValid) {
      console.warn(`[startup] ${pos.symbol} ATR SL=$${sl.toFixed(4)} invalid vs live $${livePrice.toFixed(4)} — skipping SL`);
    }

    await Promise.allSettled([
      slValid ? bybitSetStopLoss(pos.symbol, sl, pos.positionIdx) : Promise.resolve(),
      bybitSetTakeProfit(pos.symbol, tp2, pos.positionIdx),
    ]);

    await storePositionMeta(pos.symbol, {
      originalQty: pm?.originalQty ?? pos.size,
      entryPrice:  pos.entryPrice,
      sl,
      atr,
      tp1,
      tp2,
      openedAt: pm?.openedAt ?? (pos.openTime ?? Date.now()),
    }).catch(e => console.warn(`[startup] storePositionMeta ${pos.symbol}: ${e.message}`));

    console.log(`[startup] ${pos.symbol} — ATR fallback SL (no prior SL found): $${sl.toFixed(4)}`);
  }
}
