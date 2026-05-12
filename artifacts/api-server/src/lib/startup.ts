import { approvalGate }           from "./approvalGate";
import { openPosition }            from "../brokers/etoro";
import {
  openPosition    as bybitOpen,
  setOneWayMode   as bybitSetOneWayMode,
  getPositions    as bybitGetPositions,
  setStopLoss     as bybitSetStopLoss,
  setTakeProfit   as bybitSetTakeProfit,
  getKlines,
  type BybitKline,
} from "../brokers/bybit";
import { openPosition as okxOpen, testConnection, setPositionMode } from "../brokers/okx";
import { openPositionPaper }       from "../brokers/okxPaper";
import { sendApprovalRequest, sendAlert } from "../notifications/telegram";
import { syncAllHoldingsToDB }     from "./aiResponder";
import { syncTotalCapitalToDB }    from "./brokerBalance";
import { db, botStateTable, type PositionMeta } from "@workspace/db";
import { eq }                      from "drizzle-orm";

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
  existing[symbol] = meta;
  await db.update(botStateTable)
    .set({ positionMetadata: existing, lastUpdated: new Date() })
    .where(eq(botStateTable.id, 1));
}

// ── ATR-based SL/TP after every position open ────────────────────────────────
async function applyAtrSlTp(
  symbol:      string,
  direction:   "long" | "short",
  entryPrice:  number,
  positionIdx: number,
  originalQty: number,
): Promise<void> {
  const klines = await getKlines(symbol, "60", 50).catch(() => [] as BybitKline[]);
  const atr    = calcATR(klines, 14);

  if (atr === 0) {
    console.warn(`[startup] ATR=0 for ${symbol} — skipping SL/TP`);
    return;
  }

  const mult = direction === "long" ? 1 : -1;
  let   sl   = entryPrice - mult * atr * 1.5;
  const tp1  = entryPrice + mult * atr * 1.0;
  const tp2  = entryPrice + mult * atr * 2.0;

  // Hard cap: SL cannot be more than 40% from entry
  const maxSlDist = entryPrice * 0.40;
  if (Math.abs(sl - entryPrice) > maxSlDist) {
    sl = direction === "long" ? entryPrice - maxSlDist : entryPrice + maxSlDist;
    console.warn(`[startup] ${symbol} ATR SL capped at 40% from entry`);
  }

  await Promise.allSettled([
    bybitSetStopLoss(symbol,  sl,  positionIdx),
    bybitSetTakeProfit(symbol, tp1, positionIdx),
  ]);

  await storePositionMeta(symbol, {
    originalQty,
    entryPrice,
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

    const result = await bybitOpen(p.symbol, bSide, p.amountUsd * leverage, leverage, {
      stopLoss:   p.stopLossPrice,
      takeProfit: p.takeProfitPrice,
    });

    // Set ATR-based SL/TP when caller didn't provide them
    if (!p.stopLossPrice || !p.takeProfitPrice) {
      applyAtrSlTp(p.symbol, isShort ? "short" : "long", result.entryPrice, result.positionIdx, result.qty)
        .catch(e2 => console.warn(`[startup] applyAtrSlTp ${p.symbol}:`, e2.message));
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

  console.log("[startup] Broker executors registered: etoro, bybit, okx");
  console.log("[startup] Telegram notifier registered");
}

async function setSlTpForExistingPositions(): Promise<void> {
  const positions = await bybitGetPositions().catch(() => []);
  if (!positions.length) return;

  // Load existing metadata to skip already-tracked positions
  const [stateRow] = await db.select({ positionMetadata: botStateTable.positionMetadata })
    .from(botStateTable).limit(1).catch(() => [{ positionMetadata: {} }]);
  const existingMeta = (stateRow?.positionMetadata ?? {}) as Record<string, PositionMeta>;

  for (const pos of positions) {
    const hasSl  = pos.stopLoss   && pos.stopLoss   > 0;
    const hasTp  = pos.takeProfit && pos.takeProfit > 0;
    const hasMeta = !!existingMeta[pos.symbol];

    if (hasSl && hasTp && hasMeta) {
      console.log(`[startup] ${pos.symbol} already has SL/TP + metadata — skipping`);
      continue;
    }

    const direction = pos.side === "Buy" ? "long" : "short" as "long" | "short";
    const klines    = await getKlines(pos.symbol, "60", 50).catch(() => [] as BybitKline[]);
    const atr       = calcATR(klines, 14);

    if (atr === 0) {
      console.warn(`[startup] ATR=0 for ${pos.symbol} — skipping`);
      continue;
    }

    const mult  = direction === "long" ? 1 : -1;
    let   sl    = pos.entryPrice - mult * atr * 1.5;
    const tp1   = pos.entryPrice + mult * atr * 1.0;
    const tp2   = pos.entryPrice + mult * atr * 2.0;

    const maxSlDist = pos.entryPrice * 0.40;
    if (Math.abs(sl - pos.entryPrice) > maxSlDist) {
      sl = direction === "long" ? pos.entryPrice - maxSlDist : pos.entryPrice + maxSlDist;
    }

    if (!hasSl) await bybitSetStopLoss(pos.symbol,   sl,  pos.positionIdx).catch(e => console.warn(`[startup] SL ${pos.symbol}: ${e.message}`));
    if (!hasTp) await bybitSetTakeProfit(pos.symbol, tp1, pos.positionIdx).catch(e => console.warn(`[startup] TP ${pos.symbol}: ${e.message}`));

    if (!hasMeta) {
      await storePositionMeta(pos.symbol, {
        originalQty: pos.size,
        entryPrice:  pos.entryPrice,
        atr,
        tp1,
        tp2,
        openedAt:    pos.openTime ?? Date.now(),
      }).catch(e => console.warn(`[startup] storePositionMeta ${pos.symbol}: ${e.message}`));
    }

    console.log(`[startup] ATR SL/TP for ${pos.symbol} ${direction}: SL=$${sl.toFixed(4)} TP1=$${tp1.toFixed(4)} TP2=$${tp2.toFixed(4)}`);
  }
}
