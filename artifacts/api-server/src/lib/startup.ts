import { approvalGate }           from "./approvalGate";
import { backfillStructuredReflections, closeOpenTrade } from "./tradeMemoryLib";
import { openPosition }            from "../brokers/etoro";
import {
  openPosition    as bybitOpen,
  setOneWayMode   as bybitSetOneWayMode,
  getPositions    as bybitGetPositions,
  setStopLoss     as bybitSetStopLoss,
  setTakeProfit   as bybitSetTakeProfit,
  getClosedPnl    as bybitGetClosedPnl,
  getKlines,
  getTicker,
  type BybitKline,
} from "../brokers/bybit";
import { openPosition as okxOpen, testConnection, setPositionMode } from "../brokers/okx";
import { openPositionPaper }       from "../brokers/okxPaper";
import { sendApprovalRequest, sendAlert } from "../notifications/telegram";
import { syncAllHoldingsToDB }     from "./aiResponder";
import { syncTotalCapitalToDB }    from "./brokerBalance";
import { db, botStateTable, tradeLogTable, type PositionMeta } from "@workspace/db";
import { eq, isNull }              from "drizzle-orm";

export let okxPaperMode = false;

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
    trailingActive: existing[symbol]?.trailingActive,
    lastTrailPrice: existing[symbol]?.lastTrailPrice,
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

  const mult = direction === "long" ? 1 : -1;
  let   sl   = entryPrice - mult * atr * 1.5;   // LONG: below entry; SHORT: above entry
  const tp1  = entryPrice + mult * atr * 1.0;
  const tp2  = entryPrice + mult * atr * 2.0;

  // Defensive: ensure SL is on the correct side of entry regardless of formula bugs
  if (direction === "long" && sl > entryPrice) {
    console.error(`[startup] SL above entry for long — recalculating: SL=$${sl.toFixed(4)} entry=$${entryPrice.toFixed(4)}`);
    sl = entryPrice - atr * 1.5;
  }
  if (direction === "short" && sl < entryPrice) {
    console.error(`[startup] SL below entry for short — recalculating: SL=$${sl.toFixed(4)} entry=$${entryPrice.toFixed(4)}`);
    sl = entryPrice + atr * 1.5;
  }

  // Hard cap: SL cannot be more than 40% from entry
  const maxSlDist = entryPrice * 0.40;
  if (Math.abs(sl - entryPrice) > maxSlDist) {
    sl = direction === "long" ? entryPrice - maxSlDist : entryPrice + maxSlDist;
    console.warn(`[startup] ${symbol} ATR SL capped at 40% from entry`);
  }

  // Validate SL is on the correct side before submitting
  const livePrice = await getTicker(symbol).then(t => t.lastPrice).catch(() => entryPrice);
  const slValid = (direction === "long" && sl < livePrice) || (direction === "short" && sl > livePrice);

  await Promise.allSettled([
    slValid ? bybitSetStopLoss(symbol, sl, positionIdx) : Promise.resolve(),
    bybitSetTakeProfit(symbol, tp1, positionIdx),
  ]);

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

    const tp1 = (p.tp1Price && p.tp1Price > 0) ? p.tp1Price : undefined;
    const result = await bybitOpen(p.symbol, bSide, p.amountUsd * leverage, leverage, {
      stopLoss:   sl,
      takeProfit: tp,
      tp1:        tp1,
    });

    // Set ATR-based SL/TP only when Claude didn't provide valid levels
    if (!sl || !tp) {
      console.log(`[startup] ${p.symbol} missing Claude SL/TP — applying ATR fallback`);
      applyAtrSlTp(p.symbol, isShort ? "short" : "long", result.entryPrice, result.positionIdx, result.qty)
        .catch(e2 => console.warn(`[startup] applyAtrSlTp ${p.symbol}:`, e2.message));
    } else {
      // Claude provided SL/TP — store metadata so /positions can display them
      storePositionMeta(p.symbol, {
        originalQty: result.qty,
        entryPrice:  result.entryPrice,
        sl,
        tp1: tp1 ?? tp,
        tp2: tp,
        atr:         0,
        openedAt:    Date.now(),
      }).catch(e => console.warn(`[startup] storePositionMeta ${p.symbol}:`, e.message));
    }

    return { orderId: result.orderId };
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

  const livePositions = await bybitGetPositions().catch(() => []);
  const liveSymbols   = new Set(livePositions.map(p => p.symbol));

  for (const trade of bybitOpen) {
    if (liveSymbols.has(trade.symbol)) continue;

    console.log(`[reconcile] ${trade.symbol} open in DB but not on Bybit — fetching closedPnl`);
    const closed = await bybitGetClosedPnl(5, undefined, trade.symbol).catch(() => []);
    const record = closed[0];

    if (record) {
      await closeOpenTrade({
        symbol:             trade.symbol,
        broker:             "bybit",
        exitPrice:          record.avgExitPrice,
        amountUsd:          record.closedSize * record.avgEntryPrice,
        pnlOverride:        record.closedPnl,
        entryPriceOverride: record.avgEntryPrice,
      }).catch(e => console.warn(`[reconcile] closeOpenTrade ${trade.symbol}:`, (e as Error).message));
      console.log(`[reconcile] ${trade.symbol} closed — exit $${record.avgExitPrice} pnl $${record.closedPnl.toFixed(2)}`);
      await sendAlert?.([
        `🔄 <b>Reconciled: ${trade.symbol}</b>`,
        `Was open in DB but closed on Bybit`,
        `Exit: $${record.avgExitPrice.toFixed(4)} | P/L: ${record.closedPnl >= 0 ? "+" : ""}$${record.closedPnl.toFixed(2)}`,
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
    const hasSl  = pos.stopLoss   && pos.stopLoss   > 0;
    const hasTp  = pos.takeProfit && pos.takeProfit > 0;
    const hasMeta = !!existingMeta[pos.symbol];

    if (hasSl && hasTp && hasMeta) {
      const pm = existingMeta[pos.symbol]!;

      // Trailing SL above entry = locked-in profit — NEVER reset regardless of qty staleness
      if (pm.trailingActive) {
        console.log(`[startup] ${pos.symbol} — trailing SL active (SL=${pm.sl?.toFixed(4)}) preserving, not resetting`);
        continue;
      }

      // Validate stored metadata is plausible for the current position.
      // If qty or TP1 is wildly off (stale from an old session), fall through and refresh.
      const liveMarkPrice = (pos as any).markPrice as number | undefined;
      const refPrice = liveMarkPrice ?? pos.entryPrice;
      const metaQtyValid = pm.originalQty != null &&
        Math.abs(pm.originalQty / pos.size - 1) < 2.0;        // within 3× current size
      const metaTp1Valid = !pm.tp1 ||                           // no tp1 stored = ok (won't block)
        Math.abs(pm.tp1 / refPrice - 1) < 0.50;               // tp1 within 50% of current price

      if (metaQtyValid && metaTp1Valid) {
        // Validate SL direction plausibility against mark price (not entry)
        // For trailing stops, SL > entryPrice is expected — check SL < markPrice instead
        if (pm.sl && pos.side !== "None") {
          const direction = pos.side === "Buy" ? "long" : "short";
          const slAboveMark = direction === "long"  && pm.sl >= (pos.markPrice ?? refPrice);
          const slBelowMark = direction === "short" && pm.sl <= (pos.markPrice ?? refPrice);
          if (slAboveMark || slBelowMark) {
            console.error(`[startup] ${pos.symbol} SL=$${pm.sl.toFixed(4)} is on WRONG SIDE of mark $${refPrice.toFixed(4)} for ${direction} — ATR reset required`);
            // Fall through to ATR reset
          } else {
            const trailingNote = pm.trailingActive && pm.sl > pos.entryPrice ? " (trailing, locked in profit)" : "";
            console.log(`[startup] ${pos.symbol} — metadata valid, preserving Claude SL/TP${trailingNote}`);
            continue;
          }
        } else {
          console.log(`[startup] ${pos.symbol} — metadata valid, preserving Claude SL/TP`);
          continue;
        }
      }
      console.log(`[startup] ${pos.symbol} — stale metadata detected (qty=${pm.originalQty} vs pos.size=${pos.size}, tp1=${pm.tp1}, refPrice=${refPrice.toFixed(4)}) → refreshing with ATR`);
    }

    const direction = pos.side === "Buy" ? "long" : "short" as "long" | "short";
    const klines    = await getKlines(pos.symbol, "240", 28).catch(() => [] as BybitKline[]);
    const atr       = calcATR(klines, 14);

    if (atr === 0) {
      console.warn(`[startup] ATR=0 for ${pos.symbol} — skipping`);
      continue;
    }

    // Always recompute from current ATR — don't rely on stored values for exchange sync
    const mult = direction === "long" ? 1 : -1;
    let   sl   = pos.entryPrice - mult * atr * 1.5;   // LONG: below entry; SHORT: above entry
    const tp1  = pos.entryPrice + mult * atr * 1.0;
    const tp2  = pos.entryPrice + mult * atr * 2.0;

    if (direction === "long" && sl > pos.entryPrice) {
      console.error(`[startup] SL above entry for long — recalculating: SL=$${sl.toFixed(4)} entry=$${pos.entryPrice.toFixed(4)}`);
      sl = pos.entryPrice - atr * 1.5;
    }
    if (direction === "short" && sl < pos.entryPrice) {
      console.error(`[startup] SL below entry for short — recalculating: SL=$${sl.toFixed(4)} entry=$${pos.entryPrice.toFixed(4)}`);
      sl = pos.entryPrice + atr * 1.5;
    }

    const maxSlDist = pos.entryPrice * 0.40;
    if (Math.abs(sl - pos.entryPrice) > maxSlDist) {
      sl = direction === "long" ? pos.entryPrice - maxSlDist : pos.entryPrice + maxSlDist;
    }

    // Validate SL is on the correct side of the current price before submitting
    const livePrice = await getTicker(pos.symbol).then(t => t.lastPrice).catch(() => 0);
    const slValid = livePrice === 0 ||
      (direction === "long"  && sl < livePrice) ||
      (direction === "short" && sl > livePrice);

    if (!slValid) {
      console.warn(`[startup] ${pos.symbol} ATR SL=$${sl.toFixed(4)} above live price $${livePrice.toFixed(4)} — skipping SL, keeping existing`);
    }

    await Promise.allSettled([
      slValid ? bybitSetStopLoss(pos.symbol,  sl,  pos.positionIdx) : Promise.resolve(),
      bybitSetTakeProfit(pos.symbol, tp2, pos.positionIdx),
    ]);

    // Always upsert metadata so sl field is populated
    await storePositionMeta(pos.symbol, {
      originalQty: existingMeta[pos.symbol]?.originalQty ?? pos.size,
      entryPrice:  pos.entryPrice,
      sl,
      atr,
      tp1,
      tp2,
      openedAt:    existingMeta[pos.symbol]?.openedAt ?? (pos.openTime ?? Date.now()),
    }).catch(e => console.warn(`[startup] storePositionMeta ${pos.symbol}: ${e.message}`));

    console.log(`[startup] ATR SL/TP for ${pos.symbol} ${direction}: SL=$${sl.toFixed(4)} TP1=$${tp1.toFixed(4)} TP2=$${tp2.toFixed(4)}`);
  }
}
