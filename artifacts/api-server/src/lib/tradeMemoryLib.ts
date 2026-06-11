import {
  db, tradeLogTable, tradeMemoryTable, paperTradesTable, botStateTable,
  tradingRulesTable, ruleOverridesTable, type TradingRule,
} from "@workspace/db";
import { desc, isNotNull, and, eq, isNull, asc, gte, lte, gt, inArray, or, ne } from "drizzle-orm";
import { llm }                                from "./llmRouter";
import { recordTradeOutcome }                 from "./leverageManager";
import { getClosedPnl as bybitGetClosedPnl, getOrderStopType, getKlines, fetchKlines, type BybitKline }  from "../brokers/bybit";

// ─── Rule alert notifier ──────────────────────────────────────────────────────

let _ruleAlertFn: ((msg: string) => Promise<void>) | null = null;
export function registerRuleAlertFn(fn: (msg: string) => Promise<void>): void { _ruleAlertFn = fn; }

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClosedTradeParams {
  symbol:     string;
  broker:     string;
  direction:  "long" | "short";
  entryPrice: number;
  exitPrice:  number;
  amountUsd:  number;
  leverage:   number;
  reasoning?: string;
  entryAt?:   Date;
}

interface ReflectionInput {
  symbol:        string;
  direction:     string;
  entryPrice:    number;
  exitPrice:     number;
  pnl:           number;
  pnlPct:        number;
  reasoning?:    string;
  entryAt?:      Date | null;
  exitAt?:       Date | null;
  setupType?:    string | null;
  score?:        string | null;
  whyNow?:       string | null;
  sl?:           string | null;   // original entry SL — never updated post-entry
  effectiveSl?:  string | null;   // ratcheted SL if a ratchet occurred; null = no ratchet
  tp1?:          string | null;
  tp2?:          string | null;
  sourceTradeId?: string | null;
  markPriceAtDecision?: number;  // pre-order price the system used
  suppressAlerts?: boolean;      // true for backfill — don't spam old-trade execution alerts
  source?: string | null;        // 'mode_3' | 'version_b'
  exitReasonOverride?: string;   // explicit exit label — overrides P&L-derived heuristic
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const toSGT = (d: Date) => {
  const sgt = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return sgt.toISOString().replace("T", " ").slice(0, 16) + " SGT";
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function checkCandlesReachedPrice(candles: Array<{high: number; low: number}>, price: number, direction: "long" | "short"): boolean {
  if (price <= 0 || candles.length === 0) return false;
  return direction === "long"
    ? candles.some(c => c.high >= price)
    : candles.some(c => c.low <= price);
}

function getMaxProfitDuringHold(candles: Array<{high: number; low: number}>, entryPrice: number, direction: "long" | "short"): number {
  if (entryPrice <= 0 || candles.length === 0) return 0;
  let best = 0;
  for (const c of candles) {
    const pct = direction === "long"
      ? (c.high - entryPrice) / entryPrice * 100
      : (entryPrice - c.low) / entryPrice * 100;
    if (pct > best) best = pct;
  }
  return best;
}

// ─── Candle analysis helpers ──────────────────────────────────────────────────

interface CandleDetail {
  direction:    "up" | "down";
  bodyPct:      number;
  upperWickPct: number;
  lowerWickPct: number;
  volumeVsAvg:  number;
  closePosition: number;
  isPinBar:     boolean;
  isDoji:       boolean;
}

interface CandleAnalysis {
  pattern:       string[];
  highs:         number[];
  lows:          number[];
  closes:        number[];
  volumes:       number[];
  avgVolume:     number;
  volumeTrend:   "rising" | "falling";
  nearRecentHigh: boolean;
  nearRecentLow:  boolean;
  candles:       CandleDetail[];
}

function analyseCandles(candles: BybitKline[]): CandleAnalysis {
  if (!candles.length) return { pattern: [], highs: [], lows: [], closes: [], volumes: [], avgVolume: 0, volumeTrend: "falling", nearRecentHigh: false, nearRecentLow: false, candles: [] };

  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const pattern: string[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const curr = candles[i]!;
    const hh = curr.high > prev.high;
    const hl = curr.low  > prev.low;
    if (hh && hl)   pattern.push("HH/HL");
    else if (!hh && !hl) pattern.push("LH/LL");
    else if (hh)    pattern.push("HH/LL");
    else            pattern.push("LH/HL");
  }

  const avgVolume     = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const mid           = Math.floor(volumes.length / 2);
  const firstHalfVol  = volumes.slice(0, mid).reduce((a, b) => a + b, 0);
  const secondHalfVol = volumes.slice(mid).reduce((a, b) => a + b, 0);
  const volumeTrend: "rising" | "falling" = secondHalfVol > firstHalfVol ? "rising" : "falling";

  const candleDetails: CandleDetail[] = candles.map(c => {
    const range        = c.high - c.low;
    const bodyPct      = range > 0 ? Math.abs(c.close - c.open) / range * 100 : 0;
    const upperWickPct = range > 0 ? (c.high - Math.max(c.open, c.close)) / range * 100 : 0;
    const lowerWickPct = range > 0 ? (Math.min(c.open, c.close) - c.low)  / range * 100 : 0;
    return {
      direction:     c.close >= c.open ? "up" : "down",
      bodyPct,
      upperWickPct,
      lowerWickPct,
      volumeVsAvg:   avgVolume > 0 ? c.volume / avgVolume : 1,
      closePosition: range > 0 ? (c.close - c.low) / range * 100 : 50,
      isPinBar:      upperWickPct > 60 || lowerWickPct > 60,
      isDoji:        bodyPct < 10,
    };
  });

  const recentHigh    = Math.max(...highs);
  const recentLow     = Math.min(...lows);
  const lastClose     = closes[closes.length - 1] ?? 0;
  return {
    pattern, highs, lows, closes, volumes, avgVolume, volumeTrend,
    nearRecentHigh: recentHigh > 0 && Math.abs(lastClose - recentHigh) / recentHigh < 0.005,
    nearRecentLow:  recentLow  > 0 && Math.abs(lastClose - recentLow)  / recentLow  < 0.005,
    candles: candleDetails,
  };
}

// ─── logClosedTrade (eToro / legacy) ─────────────────────────────────────────

export async function logClosedTrade(params: ClosedTradeParams): Promise<void> {
  const { symbol, broker, direction, entryPrice, exitPrice, amountUsd, leverage, reasoning, entryAt } = params;
  const qty    = amountUsd / entryPrice;
  const pnl    = direction === "long"
    ? (exitPrice - entryPrice) * qty
    : (entryPrice - exitPrice) * qty;
  const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100 * (direction === "long" ? 1 : -1);

  await db.insert(tradeLogTable).values({
    symbol, broker, direction,
    entryPrice: String(entryPrice),
    exitPrice:  String(exitPrice),
    pnl:        String(pnl.toFixed(4)),
    pnlPct:     String(pnlPct.toFixed(4)),
    leverage,
    amountUsd:  String(amountUsd),
    reasoning:  reasoning ?? null,
    entryAt:    entryAt ?? new Date(),
    exitAt:     new Date(),
  });

  await recordTradeOutcome(symbol, pnlPct).catch(() => {});

  generateReflection({ symbol, direction, entryPrice, exitPrice, pnl, pnlPct, reasoning,
    entryAt: entryAt ?? new Date(), exitAt: new Date() })
    .catch(e => console.error("[tradeMemory] reflection failed:", e));

  updateRuleStatsForTrade(pnlPct > 0).catch(() => {});
  updatePendingOverrides(symbol, pnlPct).catch(() => {});
  checkAndGenerateRules().catch(() => {});
}

// ─── Core reflection engine ───────────────────────────────────────────────────

export async function generateReflection(input: ReflectionInput, _retryCount = 0): Promise<void> {
  const sign = input.pnl >= 0 ? "+" : "";

  // 1. Fetch Bybit closed-pnl for this symbol within the trade window
  type BybitClose = { closedSize: number; avgExitPrice: number; avgEntryPrice: number; closedPnl: number; closedAt: number; closeOrderCreatedAt: number; side: string };
  let bybitCloses: BybitClose[] = [];
  if (input.entryAt) {
    try {
      const startMs = Math.max(0, input.entryAt.getTime() - 4 * 60 * 60 * 1000);
      const raw = await bybitGetClosedPnl(50, startMs, input.symbol);
      bybitCloses = raw
        .filter(c => Math.abs(c.avgEntryPrice / input.entryPrice - 1) < 0.06)
        .sort((a, b) => a.closedAt - b.closedAt);
    } catch { /* non-fatal — Bybit data enriches but isn't required */ }
  }

  const bybitTotalPnl   = bybitCloses.reduce((s, c) => s + c.closedPnl, 0);
  const bybitTotalQty   = bybitCloses.reduce((s, c) => s + c.closedSize, 0);
  const partials        = bybitCloses.length > 1 ? bybitCloses.slice(0, -1) : [];
  const estimatedFees   = Math.abs(input.pnl) * 0.002; // ~0.1% in + 0.1% out taker approx

  // 2. Candle data for trade period (1h candles, entry→exit)
  type Candle1h = { high: number; low: number; close: number; time: number };
  let tradePeriodCandles: Candle1h[] = [];
  try {
    if (input.entryAt && input.exitAt) {
      const holdHrs = Math.ceil((input.exitAt.getTime() - input.entryAt.getTime()) / 3_600_000) + 2;
      const limit = Math.min(200, Math.max(10, holdHrs));
      const raw = await getKlines(input.symbol, "60", limit);
      const entryMs = input.entryAt.getTime();
      const exitMs  = input.exitAt.getTime();
      tradePeriodCandles = raw
        .filter((k: Candle1h & { ts: number }) => k.ts >= entryMs - 3_600_000 && k.ts <= exitMs + 3_600_000)
        .map((k: Candle1h & { ts: number }) => ({ high: k.high, low: k.low, close: k.close, time: k.ts }));
    }
  } catch { /* non-fatal */ }

  // 3. Partial closes from trade_memory for this symbol in trade window
  type PartialMem = { partialType: string | null; priceAtClose: string | null; pnlPct: string | null; createdAt: Date };
  let memPartials: PartialMem[] = [];
  try {
    if (input.entryAt && input.exitAt) {
      const windowStart = new Date(input.entryAt.getTime() - 30 * 60_000);
      const windowEnd   = new Date(input.exitAt.getTime() + 30 * 60_000);
      memPartials = await db.select({
        partialType:  tradeMemoryTable.partialType,
        priceAtClose: tradeMemoryTable.priceAtClose,
        pnlPct:       tradeMemoryTable.pnlPct,
        createdAt:    tradeMemoryTable.createdAt,
      }).from(tradeMemoryTable)
        .where(and(
          eq(tradeMemoryTable.symbol, input.symbol),
          eq(tradeMemoryTable.action, "PARTIAL"),
          gte(tradeMemoryTable.createdAt, windowStart),
          lte(tradeMemoryTable.createdAt, windowEnd),
        ))
        .orderBy(asc(tradeMemoryTable.createdAt));
    }
  } catch { /* non-fatal */ }

  // 4. Version B comparison (paper_trades)
  let versionBStr = "Version B had no trade on this symbol in the same period.";
  try {
    if (input.entryAt) {
      const windowStart = new Date(input.entryAt.getTime() - 48 * 60 * 60 * 1000);
      const windowEnd   = input.exitAt ? new Date(input.exitAt.getTime() + 48 * 60 * 60 * 1000) : new Date();
      const [vb] = await db.select().from(paperTradesTable)
        .where(and(
          eq(paperTradesTable.symbol, input.symbol),
          eq(paperTradesTable.version, "B"),
          gte(paperTradesTable.signalTime, windowStart),
          lte(paperTradesTable.signalTime, windowEnd),
        ))
        .orderBy(desc(paperTradesTable.signalTime))
        .limit(1);
      if (vb) {
        const vbRes = vb.wouldHavePnlPct != null
          ? `${vb.wouldHavePnlPct >= 0 ? "+" : ""}${vb.wouldHavePnlPct.toFixed(2)}%`
          : vb.status === "open" ? "still open" : "not resolved";
        versionBStr = [
          `Version B direction: ${vb.direction}`,
          `Version B entry: $${vb.entryPrice.toFixed(4)}`,
          `Version B score: ${vb.score ?? "?"} | setup: ${vb.setupType ?? "?"} | regime: ${vb.regime ?? "?"}`,
          `Version B result: ${vbRes}`,
          vb.whyNow ? `Version B whyNow: ${vb.whyNow}` : "",
        ].filter(Boolean).join("\n");
      }
    }
  } catch { /* non-fatal */ }

  // 3. Current regime from bot_state
  let regime = "UNKNOWN";
  try {
    const [state] = await db.select({ currentRegime: botStateTable.currentRegime })
      .from(botStateTable).limit(1);
    regime = state?.currentRegime ?? "UNKNOWN";
  } catch { /* non-fatal */ }

  // 5a. Pre/entry/post candle data
  let preCandles1h:  BybitKline[] = [];
  let preCandles15m: BybitKline[] = [];
  let btcPreCandles: BybitKline[] = [];
  let entryCandle1h: BybitKline[] = [];
  let entryCandle15m: BybitKline[] = [];
  if (input.entryAt) {
    try {
      [preCandles1h, preCandles15m, btcPreCandles, entryCandle1h, entryCandle15m] = await Promise.all([
        fetchKlines({ symbol: input.symbol, interval: "60", end: input.entryAt, limit: 12 }),
        fetchKlines({ symbol: input.symbol, interval: "15", end: input.entryAt, limit: 8 }),
        fetchKlines({ symbol: "BTCUSDT",    interval: "60", end: input.entryAt, limit: 12 }),
        fetchKlines({ symbol: input.symbol, interval: "60", end: input.entryAt, limit: 1 }),
        fetchKlines({ symbol: input.symbol, interval: "15", end: input.entryAt, limit: 1 }),
      ]);
    } catch { /* non-fatal */ }
  }

  let postCandles1h:  BybitKline[] = [];
  let postCandles15m: BybitKline[] = [];
  let btcPostCandles: BybitKline[] = [];
  if (input.exitAt) {
    try {
      [postCandles1h, postCandles15m, btcPostCandles] = await Promise.all([
        fetchKlines({ symbol: input.symbol, interval: "60", start: input.exitAt, limit: 24 }),
        fetchKlines({ symbol: input.symbol, interval: "15", start: input.exitAt, limit: 8 }),
        fetchKlines({ symbol: "BTCUSDT",    interval: "60", start: input.exitAt, limit: 24 }),
      ]);
    } catch { /* non-fatal */ }
  }

  // 5b. Signal accuracy from past reflections
  const signalAccMap: Record<string, { worked: number; failed: number }> = {};
  try {
    const sigRows = await db.select({
      signalsThatWorked: tradeMemoryTable.signalsThatWorked,
      signalsThatFailed: tradeMemoryTable.signalsThatFailed,
    }).from(tradeMemoryTable)
      .where(and(
        eq(tradeMemoryTable.action,    "TRADE_CLOSE"),
        gte(tradeMemoryTable.createdAt, new Date('2026-06-04T00:00:00Z')),
      ))
      .orderBy(desc(tradeMemoryTable.createdAt))
      .limit(50);
    for (const row of sigRows) {
      for (const s of JSON.parse(row.signalsThatWorked ?? "[]") as string[]) {
        if (!signalAccMap[s]) signalAccMap[s] = { worked: 0, failed: 0 };
        signalAccMap[s].worked++;
      }
      for (const s of JSON.parse(row.signalsThatFailed ?? "[]") as string[]) {
        if (!signalAccMap[s]) signalAccMap[s] = { worked: 0, failed: 0 };
        signalAccMap[s].failed++;
      }
    }
  } catch { /* non-fatal */ }

  // 5c. Candle analysis
  const preAnalysis1h   = analyseCandles(preCandles1h);
  const preAnalysis15m  = analyseCandles(preCandles15m);
  const entryAnal1h     = analyseCandles(entryCandle1h).candles[0];
  const entryAnal15m    = analyseCandles(entryCandle15m).candles[0];
  const postAnalysis1h  = analyseCandles(postCandles1h);
  const postAnalysis15m = analyseCandles(postCandles15m);

  const blankCandle: CandleDetail = { direction: "up", bodyPct: 0, upperWickPct: 0, lowerWickPct: 0, volumeVsAvg: 1, closePosition: 50, isPinBar: false, isDoji: false };
  const entryC1h  = entryAnal1h  ?? blankCandle;
  const entryC15m = entryAnal15m ?? blankCandle;

  // 5d. Derived metrics
  const firstPreClose = preCandles1h[0]?.close ?? input.entryPrice;
  const lastPreClose  = preCandles1h[preCandles1h.length - 1]?.close ?? input.entryPrice;
  const preTrendPct   = firstPreClose > 0 ? (lastPreClose - firstPreClose) / firstPreClose * 100 : 0;

  const firstBtcPre  = btcPreCandles[0]?.close ?? 0;
  const lastBtcPre   = btcPreCandles[btcPreCandles.length - 1]?.close ?? 0;
  const btcTrendPct  = firstBtcPre > 0 ? (lastBtcPre - firstBtcPre) / firstBtcPre * 100 : 0;
  const btcVsSymbol  = (preTrendPct >= 0) === (btcTrendPct >= 0) ? "aligned" : "diverging";

  const price1hAfter  = postCandles1h[0]?.close  ?? 0;
  const price4hAfter  = postCandles1h[3]?.close  ?? 0;
  const price24hAfter = postCandles1h[23]?.close ?? 0;

  const after4hClose  = price4hAfter  || input.exitPrice;
  const after24hClose = price24hAfter || input.exitPrice;
  const immediateReactionPct = input.exitPrice > 0 ? (after4hClose  - input.exitPrice) / input.exitPrice * 100 : 0;
  const fullMove24hPct       = input.exitPrice > 0 ? (after24hClose - input.exitPrice) / input.exitPrice * 100 : 0;

  const firstBtcPost = btcPostCandles[0]?.close ?? 0;
  const lastBtcPost  = btcPostCandles[btcPostCandles.length - 1]?.close ?? 0;
  const btcPostMovePct = firstBtcPost > 0 ? (lastBtcPost - firstBtcPost) / firstBtcPost * 100 : 0;

  const isLong = input.direction === "long";
  const postHighs = postCandles1h.map(c => c.high);
  const postLows  = postCandles1h.map(c => c.low);
  const maxAdditionalLossPct = input.exitPrice > 0 && postCandles1h.length > 0
    ? (isLong
       ? (input.exitPrice - Math.min(...postLows))  / input.exitPrice * 100
       : (Math.max(...postHighs) - input.exitPrice) / input.exitPrice * 100)
    : 0;
  const additionalGainPct = input.exitPrice > 0 && postCandles1h.length > 0
    ? (isLong
       ? (Math.max(...postHighs) - input.exitPrice) / input.exitPrice * 100
       : (input.exitPrice - Math.min(...postLows))  / input.exitPrice * 100)
    : 0;

  const btcContextPre  = btcPreCandles.length > 0
    ? `BTC ${btcTrendPct >= 0 ? "+" : ""}${btcTrendPct.toFixed(2)}% over 12h pre-entry (${btcVsSymbol} with ${input.symbol})`
    : "BTC context unavailable";
  const btcContextPost = btcPostCandles.length > 0
    ? `BTC ${btcPostMovePct >= 0 ? "+" : ""}${btcPostMovePct.toFixed(2)}% over 24h post-exit`
    : "BTC context unavailable";

  const signalAccuracyLines = Object.keys(signalAccMap).length > 0
    ? Object.entries(signalAccMap).map(([sig, s]) => {
        const total = s.worked + s.failed;
        const pct = (s.worked / total * 100).toFixed(0);
        return `${sig}: ${pct}% accurate (${total} samples)`;
      }).join("\n")
    : "No signal history yet";

  // ── Execution quality checks ──────────────────────────────────────────────
  const tp1Price   = input.tp1   ? parseFloat(input.tp1)  : 0;
  const tp2Price   = input.tp2   ? parseFloat(input.tp2)  : 0;
  const plannedSL  = input.sl    ? parseFloat(input.sl)   : 0;   // always original entry SL
  const effectiveSL     = input.effectiveSl ? parseFloat(input.effectiveSl) : 0;
  const slWasRatcheted  = effectiveSL > 0 && Math.abs(effectiveSL - plannedSL) > 0.0001;

  const tp1Reached = checkCandlesReachedPrice(tradePeriodCandles, tp1Price, input.direction as "long" | "short");
  const tp2Reached = checkCandlesReachedPrice(tradePeriodCandles, tp2Price, input.direction as "long" | "short");
  // Also treat as executed if Bybit shows multiple partial closes — exchange-level
  // PartialTakeProfit fires without writing a trade_memory PARTIAL record.
  const tp1Executed = memPartials.some(p => p.partialType === "tp1") || bybitCloses.length > 1;
  // Exchange-side TP2 fallback: query stopOrderType on the final close order's orderId.
  // This is a point query on a specific orderId — no cross-symbol contamination risk
  // (unlike tp1's count heuristic which relies only on the 6% entry-price filter).
  let tp2ExecutedBybit = false;
  if (bybitCloses.length > 0) {
    const lastOrderId = bybitCloses[bybitCloses.length - 1]!.orderId;
    try {
      const stopType = await getOrderStopType(input.symbol, lastOrderId);
      tp2ExecutedBybit = stopType === "TakeProfit";
    } catch { /* non-fatal — fall back to memPartials-only result */ }
  }
  const tp2Executed = memPartials.some(p => p.partialType === "tp2") || tp2ExecutedBybit;
  // True when posMonitor issued a discretionary PARTIAL_CLOSE during this trade.
  // Used to route tp2Verdict='na' — the bot's judgment ended the trade, not TP2 distance.
  const hadReviewPartial = memPartials.some(p => p.partialType === "review_partial");

  const maxProfitPct = getMaxProfitDuringHold(tradePeriodCandles, input.entryPrice, input.direction as "long" | "short");

  // Fraction of TP1→TP2 corridor price reached. Uses Math.abs so distances are
  // direction-agnostic (both tp1Price and tp2Price are on the profitable side of entry).
  // maxProfitPct covers the full hold (entry→final exit) and is not truncated at TP1.
  const tp1DistancePct = tp1Price > 0 && input.entryPrice > 0
    ? Math.abs(tp1Price - input.entryPrice) / input.entryPrice * 100 : 0;
  const tp2DistancePct = tp2Price > 0 && input.entryPrice > 0
    ? Math.abs(tp2Price - input.entryPrice) / input.entryPrice * 100 : 0;
  const tp2Corridor = tp2DistancePct - tp1DistancePct;
  const tp2ProgressPct: number | null = (tp1Executed && tp2Corridor > 0)
    ? Math.min(1, Math.max(0, (maxProfitPct - tp1DistancePct) / tp2Corridor))
    : null;

  const actualExitPrice = bybitCloses.length > 0
    ? bybitCloses[bybitCloses.length - 1]!.avgExitPrice
    : input.exitPrice;
  const expectedExitPrice = input.markPriceAtDecision ?? input.exitPrice;
  const slippage = expectedExitPrice > 0
    ? Math.abs(actualExitPrice - expectedExitPrice) / expectedExitPrice * 100
    : 0;

  const executionIssues: string[] = [];
  if (tp1Price > 0 && tp1Reached && !tp1Executed) executionIssues.push("TP1 reached but not triggered");
  if (tp2Price > 0 && tp2Reached && !tp2Executed) executionIssues.push("TP2 reached but not triggered");
  if (slippage > 1.5)     executionIssues.push(`Significant slippage: ${slippage.toFixed(2)}%`);
  if (plannedSL > 0) {
    const slDirectionOk = input.direction === "long" ? plannedSL < input.entryPrice : plannedSL > input.entryPrice;
    if (!slDirectionOk) executionIssues.push("SL direction wrong");
  }
  const unplannedPartials = memPartials.filter(p =>
    !["tp1","tp2","large_profit","review_partial"].includes(p.partialType ?? "")
  );
  if (unplannedPartials.length > 0) executionIssues.push(`Unplanned partials: ${unplannedPartials.map(p => p.partialType).join(", ")}`);
  if (memPartials.length > 3) executionIssues.push(`Excessive partials: ${memPartials.length} closes`);

  // Determine exit method — explicit override wins; otherwise derive from partials/bybit data
  const exitMethod = input.exitReasonOverride
    ? input.exitReasonOverride
    : memPartials.some(p => p.partialType === "large_profit")
      ? "profit_protection"
      : bybitCloses.length > 0 && bybitCloses[bybitCloses.length-1]!.closedPnl !== undefined
        ? (input.pnlPct < -5 ? "sl_hit" : "review")
        : "unknown";

  // Exit branch — ratcheted_sl covers post-TP1 ratchet (paths A/B/D) AND breakeven-before-TP1 (path C)
  const exitBranch: "original_sl" | "ratcheted_sl" | "tp_hit" | "other" =
    tp2Executed                                                     ? "tp_hit"
    : exitMethod === "tp_hit"                                       ? "tp_hit"
    : ((tp1Executed || slWasRatcheted) && exitMethod === "sl_hit")  ? "ratcheted_sl"
    : exitMethod === "sl_hit"                                       ? "original_sl"
    : "other";

  // Effective SL display distance (for prompt context only — not used for slTooTight assessment)
  const effectiveSlDistancePct = effectiveSL > 0 && input.entryPrice > 0
    ? Math.abs(effectiveSL - input.entryPrice) / input.entryPrice * 100 : 0;

  // Entry regime — parse from trade's stored reasoning (bot_state.currentRegime is today's regime)
  const entryRegime = (input.reasoning?.match(/regime=([A-Z_]+)/)?.[1]) ?? "UNKNOWN";
  const isStrongTrend = entryRegime === "STRONG_TREND";

  const tradeLost = input.pnlPct < 0;
  const failureType: "strategy" | "execution" | "mixed" | "success" =
    !tradeLost          ? "success"
    : executionIssues.length > 2 ? "execution"
    : executionIssues.length > 0 ? "mixed"
    : "strategy";


  // Phase 3: walk-forward reconstruction — manual_partial and manual_full
  let reconstruction: ReconstructionResult | null = null;
  // Reuse already-parsed level values from above
  const tp1Val = tp1Price;
  const tp2Val = tp2Price;
  const slVal  = plannedSL;
  if (exitMethod === "manual_partial" && tp2Val > 0 && input.exitAt) {
    // TP1 already fired — use ratcheted SL, walk toward TP2
    const ratchetedSL = input.direction === "long" ? input.entryPrice * 1.01 : input.entryPrice * 0.99;
    try {
      reconstruction = await reconstructForwardFromClose({
        symbol:    input.symbol,
        direction: input.direction as "long" | "short",
        sl:        ratchetedSL,
        tp2:       tp2Val,
        startAt:   input.exitAt,
      });
      console.log(`[reconstruction] ${input.symbol}: ${reconstruction.outcome} after ${reconstruction.candlesWalked} candles`);
    } catch (e) {
      console.warn(`[reconstruction] ${input.symbol} failed:`, (e as Error).message);
    }
  } else if (exitMethod === "manual_full" && tp1Val > 0 && slVal > 0 && input.exitAt) {
    // Full early exit — use original SL, walk toward TP1 (and TP2 if available)
    try {
      reconstruction = await reconstructForwardFromClose({
        symbol:    input.symbol,
        direction: input.direction as "long" | "short",
        sl:        slVal,
        tp1:       tp1Val,
        tp2:       tp2Val > 0 ? tp2Val : undefined,
        startAt:   input.exitAt,
      });
      console.log(`[reconstruction] ${input.symbol}: ${reconstruction.outcome} after ${reconstruction.candlesWalked} candles`);
    } catch (e) {
      console.warn(`[reconstruction] ${input.symbol} failed:`, (e as Error).message);
    }
  } else if (exitMethod === "manual_partial" && tp2Val <= 0) {
    console.log(`[reconstruction] ${input.symbol}: skipped — manual_partial but no tp2`);
  } else if (exitMethod === "manual_full" && (tp1Val <= 0 || slVal <= 0)) {
    console.log(`[reconstruction] ${input.symbol}: skipped — manual_full but missing tp1/sl (tp1=${tp1Val}, sl=${slVal})`);
  }

  // SL tightness assessment — min/max price during hold
  const minPriceDuringHold = tradePeriodCandles.length > 0 ? Math.min(...tradePeriodCandles.map(c => c.low)) : 0;
  const maxPriceDuringHold = tradePeriodCandles.length > 0 ? Math.max(...tradePeriodCandles.map(c => c.high)) : 0;
  const maxAdverseMoveHoldPct = isLong
    ? (minPriceDuringHold > 0 && input.entryPrice > 0 ? (input.entryPrice - minPriceDuringHold) / input.entryPrice * 100 : 0)
    : (maxPriceDuringHold > 0 && input.entryPrice > 0 ? (maxPriceDuringHold - input.entryPrice) / input.entryPrice * 100 : 0);
  const slDistancePct = plannedSL > 0 && input.entryPrice > 0
    ? Math.abs(plannedSL - input.entryPrice) / input.entryPrice * 100 : 0;

  // 5. Hold duration
  const holdMs      = input.entryAt && input.exitAt
    ? input.exitAt.getTime() - input.entryAt.getTime() : null;
  const holdHours   = holdMs !== null ? Math.floor(holdMs / 3600000) : null;
  const holdMinutes = holdMs !== null ? Math.floor((holdMs % 3600000) / 60000) : null;

  // 5. Partial close description
  const partialsSection = partials.length > 0
    ? partials.map((p, i) => {
        const pct = bybitTotalQty > 0 ? Math.round(p.closedSize / bybitTotalQty * 100) : 0;
        return [
          `→ Partial ${i + 1} at ${toSGT(new Date(p.closedAt))}:`,
          `  Closed ${p.closedSize} (≈${pct}% of position)`,
          `  Price: $${p.avgExitPrice.toFixed(4)} | P/L: ${p.closedPnl >= 0 ? "+" : ""}$${p.closedPnl.toFixed(2)}`,
        ].join("\n");
      }).join("\n")
    : "No partial closes recorded for this position.";

  // 6. Enhanced prompt with candle analysis
  const fmt2 = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2);
  const candleRow1h = (c: CandleDetail, i: number) =>
    `Candle ${i + 1}: ${c.direction} | body:${c.bodyPct.toFixed(0)}% wick↑:${c.upperWickPct.toFixed(0)}% wick↓:${c.lowerWickPct.toFixed(0)}% | vol:${c.volumeVsAvg.toFixed(1)}×avg${c.isPinBar ? " [PIN BAR]" : ""}${c.isDoji ? " [DOJI]" : ""}`;
  const candleRow15m = (c: CandleDetail, i: number) =>
    `15m-${i + 1}: ${c.direction} | body:${c.bodyPct.toFixed(0)}% vol:${c.volumeVsAvg.toFixed(1)}×avg${c.isPinBar ? " [PIN BAR]" : ""}`;

  const prompt = [
    `Complete trade analysis for structured reflection:`,
    ``,
    `═══ TRADE BASICS ═══`,
    `Symbol: ${input.symbol}`,
    `Direction: ${input.direction} (confirmed from Bybit side field)`,
    `Entry: $${input.entryPrice.toFixed(4)}${input.entryAt ? ` at ${toSGT(input.entryAt)}` : ""}`,
    `Final exit: $${input.exitPrice.toFixed(4)}${input.exitAt ? ` at ${toSGT(input.exitAt)}` : ""}`,
    holdHours !== null ? `Hold duration: ${holdHours}h ${holdMinutes}m` : "",
    bybitTotalPnl !== 0
      ? `Gross P/L (Bybit verified): ${bybitTotalPnl >= 0 ? "+" : ""}$${bybitTotalPnl.toFixed(2)} | Est. fees: ~$${estimatedFees.toFixed(2)}`
      : `Gross P/L: ${sign}$${input.pnl.toFixed(2)} | Est. fees: ~$${estimatedFees.toFixed(2)}`,
    `Net P/L: ${sign}${input.pnlPct.toFixed(2)}%`,
    `Exit method: ${exitMethod}`,
    ``,
    `═══ PRE-TRADE CONTEXT (12h before entry) ═══`,
    ``,
    `1h candle analysis (${preAnalysis1h.candles.length} candles):`,
    `Price structure pattern: ${preAnalysis1h.pattern.join(" → ") || "n/a"}`,
    `Overall trend: ${fmt2(preTrendPct)}% over 12h`,
    `Volume trend: ${preAnalysis1h.volumeTrend}`,
    `Near recent high: ${preAnalysis1h.nearRecentHigh}`,
    `Near recent low: ${preAnalysis1h.nearRecentLow}`,
    preAnalysis1h.candles.length > 0 ? `Key candle observations:\n${preAnalysis1h.candles.map(candleRow1h).join("\n")}` : "",
    ``,
    `15m candle analysis (${preAnalysis15m.candles.length} candles = 2h before entry):`,
    `Pattern: ${preAnalysis15m.pattern.join(" → ") || "n/a"}`,
    `Volume trend: ${preAnalysis15m.volumeTrend}`,
    preAnalysis15m.candles.length > 0 ? preAnalysis15m.candles.map(candleRow15m).join("\n") : "",
    ``,
    `BTC context (same 12h): ${btcContextPre}`,
    ``,
    `═══ ENTRY CANDLE ANALYSIS ═══`,
    ``,
    `1h entry candle:`,
    `Direction: ${entryC1h.direction}`,
    `Body strength: ${entryC1h.bodyPct.toFixed(0)}% of range`,
    `Upper wick: ${entryC1h.upperWickPct.toFixed(0)}%${entryC1h.upperWickPct > 40 ? " [rejection of highs]" : ""}`,
    `Lower wick: ${entryC1h.lowerWickPct.toFixed(0)}%${entryC1h.lowerWickPct > 40 ? " [rejection of lows]" : ""}`,
    `Volume: ${entryC1h.volumeVsAvg.toFixed(1)}× average`,
    `Close position: ${entryC1h.closePosition.toFixed(0)}% of range`,
    `Pattern: ${entryC1h.isPinBar ? "PIN BAR" : entryC1h.isDoji ? "DOJI" : "normal"}`,
    ``,
    `15m entry candle: ${entryC15m.direction} | body:${entryC15m.bodyPct.toFixed(0)}% | vol:${entryC15m.volumeVsAvg.toFixed(1)}×avg`,
    ``,
    `═══ SIGNALS USED IN DECISION ═══`,
    `Original entry reasoning: ${input.whyNow ?? input.reasoning ?? "unknown"}`,
    `Setup type: ${input.setupType ?? "unknown"}`,
    `Score at entry: ${input.score ?? "unknown"}/100`,
    `Regime: ${regime}`,
    `SL: ${input.sl ? "$" + parseFloat(input.sl).toFixed(4) : "not set"} | TP1: ${input.tp1 ? "$" + parseFloat(input.tp1).toFixed(4) : "not set"} | TP2: ${input.tp2 ? "$" + parseFloat(input.tp2).toFixed(4) : "not set"}`,
    ``,
    `Signal accuracy history (from past trades):`,
    signalAccuracyLines,
    ``,
    `═══ VERSION B COMPARISON ═══`,
    versionBStr,
    ``,
    `═══ POST-TRADE ANALYSIS (after exit) ═══`,
    ``,
    `Price 1h after exit: $${price1hAfter > 0 ? price1hAfter.toFixed(4) : "n/a"}`,
    `Price 4h after exit: $${price4hAfter > 0 ? price4hAfter.toFixed(4) : "n/a"} (${fmt2(immediateReactionPct)}%)`,
    `Price 24h after exit: $${price24hAfter > 0 ? price24hAfter.toFixed(4) : "n/a"} (${fmt2(fullMove24hPct)}%)`,
    `BTC post-exit: ${btcContextPost}`,
    ``,
    postAnalysis1h.candles.length > 0
      ? `1h candles after exit:\n${postAnalysis1h.candles.slice(0, 8).map((c, i) => `Post-${i + 1}h: ${c.direction} | body:${c.bodyPct.toFixed(0)}% vol:${c.volumeVsAvg.toFixed(1)}×avg`).join("\n")}` : "",
    postAnalysis15m.candles.length > 0
      ? `15m immediate reaction:\n${postAnalysis15m.candles.map((c, i) => `Post-15m-${i + 1}: ${c.direction} | body:${c.bodyPct.toFixed(0)}%`).join("\n")}` : "",
    ``,
    ["manual_full","manual_partial"].includes(exitMethod)
      ? `MANUAL EXIT: Position closed by human, not by bot SL/TP. Price moved ${fmt2(additionalGainPct)}% in trade direction after close.`
      : exitMethod === "sl_hit"
        ? `SL EXIT: Max additional loss avoided if SL held: ${maxAdditionalLossPct.toFixed(2)}%\nDid price continue against position? ${maxAdditionalLossPct > 1 ? "YES — SL saved further loss" : "NO — SL may have been premature"}`
        : `TP EXIT: Additional gain available after exit: ${additionalGainPct.toFixed(2)}%\nDid price continue in our direction? ${additionalGainPct > 2 ? "YES — TP too conservative" : "NO — TP well timed"}`,
    ``,
    `═══ EXECUTION ANALYSIS ═══`,
    `CRITICAL: executed=YES/NO is derived from bot trade_memory records plus Bybit close count.`,
    `Do NOT speculate about whether specific orders fired or failed based on price metadata alone.`,
    `Only populate executionIssues with unambiguous failures evident in the data provided.`,
    `If tp1_reached=YES and Bybit shows multiple partial closes, assume TP1 fired correctly.`,
    `If uncertain, set executionIssues to []. Never fabricate partial close prices.`,
    `TP1 ($${tp1Price > 0 ? tp1Price.toFixed(4) : "not set"}): reached=${tp1Reached ? "YES" : "NO"} | executed=${tp1Executed ? "YES" : "NO"}${tp1Price > 0 && tp1Reached && !tp1Executed ? " ⚠️ MISSED" : ""}`,
    `TP2 ($${tp2Price > 0 ? tp2Price.toFixed(4) : "not set"}): reached=${tp2Reached ? "YES" : "NO"} | executed=${tp2Executed ? "YES" : "NO"}`,
    `Max profit during hold: ${maxProfitPct.toFixed(2)}%`,
    `Slippage: ${slippage.toFixed(3)}%${slippage > 1.5 ? " ⚠️ SIGNIFICANT" : ""}`,
    `Partial closes: ${memPartials.length > 0 ? memPartials.map(p => `${p.partialType ?? "?"}@$${parseFloat(p.priceAtClose ?? "0").toFixed(4)}`).join(", ") : "none"}`,
    `Execution issues: ${executionIssues.length > 0 ? executionIssues.join("; ") : "none"}`,
    `Failure type: ${failureType.toUpperCase()}`,
    `Partial close history:\n${partialsSection}`,
    ``,
    failureType === "execution"
      ? `IMPORTANT: EXECUTION failure. Identify the specific system bug.`
      : failureType === "strategy"
      ? `IMPORTANT: STRATEGY failure. What signals were missed? What to do differently?`
      : failureType === "mixed"
      ? `IMPORTANT: MIXED failure. Address both execution issues AND strategy quality.`
      : `IMPORTANT: Successful trade. Reinforce what worked.`,
    ``,
    `═══ ENTRY ASSESSMENT ═══`,
    `Entry direction: ${input.direction.toUpperCase()}`,
    `Entry price: $${input.entryPrice.toFixed(4)}`,
    `Pre-trade trend: ${fmt2(preTrendPct)}% over 12h`,
    `Entry candle: ${entryC1h.direction} body=${entryC1h.bodyPct.toFixed(0)}% vol=${entryC1h.volumeVsAvg.toFixed(1)}×avg${entryC1h.isPinBar ? " [PIN BAR]" : ""}`,
    `Verdict needed: early (entered before setup confirmed), good (right time/price), late (chased extended move), wrong (entered on wrong side of structure)`,
    ``,
    `═══ SL ASSESSMENT ═══`,
    `Exit branch: ${
      exitBranch === "original_sl"  ? "BRANCH 1 — original entry SL hit (no TP1 fired, no ratchet)" :
      exitBranch === "ratcheted_sl" ? `BRANCH 2 — ratcheted SL hit (profit-protection ratchet moved SL from original entry level${tp1Executed ? "; TP1 captured partial profit" : "; path-C breakeven lock, no TP1 fired"})` :
      exitBranch === "tp_hit"       ? "BRANCH 3 — TP exit (target reached, clean win)" :
                                      "BRANCH OTHER — manual/review close"
    }`,
    `Original entry SL: $${plannedSL > 0 ? plannedSL.toFixed(4) : "not set"} (${slDistancePct.toFixed(2)}% from entry)`,
    slWasRatcheted
      ? `Ratcheted SL at exit: $${effectiveSL.toFixed(4)} (${effectiveSlDistancePct.toFixed(2)}% from entry) — applied by profit-protection ratchet${tp1Executed ? " after TP1" : " before TP1 (path-C breakeven lock)"}`
      : `No SL ratchet — original SL was the active level throughout`,
    `Max adverse move DURING hold: ${maxAdverseMoveHoldPct.toFixed(2)}% from entry`,
    `Was SL hit this trade: ${exitMethod === "sl_hit" ? "YES" : "NO"}`,
    `Post-exit adverse continuation: ${maxAdditionalLossPct.toFixed(2)}%`,
    exitBranch === "original_sl"
      ? `→ slTooTight verdict: was the ORIGINAL entry SL ($${plannedSL.toFixed(4)}, ${slDistancePct.toFixed(2)}% away) placed inside the noise zone? too_tight = SL hit but price then moved in trade direction (original SL was premature). good = appropriate distance. too_wide = absorbed excessive loss before stopping out.`
      : exitBranch === "ratcheted_sl"
      ? (tp1Executed
        ? `→ slTooTight MUST BE false. The ORIGINAL entry SL was never hit — it was replaced by a profit-protection ratchet after TP1. Set slTooTight=false unconditionally. Instead assess tp2Verdict: was TP2 placed too far to be realistically reached after TP1?`
        : `→ slTooTight MUST BE false. The ORIGINAL entry SL was never hit — price moved 2%+ into profit triggering a breakeven lock (path-C), then reversed to entry. Set slTooTight=false unconditionally. The original SL distance is irrelevant here. Focus entryTimingVerdict on whether entry timing was early/wrong, and TP1 placement on whether a closer TP1 would have locked profit before the reversal.`)
      : `→ slTooTight = false (not applicable for TP exits and manual/review closes)`,
    ["manual_full","manual_partial"].includes(exitMethod)
      ? `Verdict needed: na — human closed position, SL was not the exit mechanism`
      : null,
    ``,
    `═══ TP ASSESSMENT ═══`,
    `TP1: $${tp1Price > 0 ? tp1Price.toFixed(4) : "not set"} — reached=${tp1Reached ? "YES" : "NO"} | executed=${tp1Executed ? "YES" : "NO"}`,
    `TP2: $${tp2Price > 0 ? tp2Price.toFixed(4) : "not set"} — reached=${tp2Reached ? "YES" : "NO"} | executed=${tp2Executed ? "YES" : "NO"}`,
    `Max profit during hold: ${maxProfitPct.toFixed(2)}%`,
    `Additional gain available after exit: ${additionalGainPct.toFixed(2)}%`,
    `TP1 verdict: too_tight (price ran far past TP1 quickly — target too conservative), good, too_ambitious (price never reached TP1)`,
    exitBranch === "ratcheted_sl"
      ? (!tp1Executed
        ? `TP2 verdict: na — TP1 never fired (path-C breakeven lock exited at entry price). Set tp2Verdict="na". The relevant TP1 question is in the TP ASSESSMENT above.`
        : hadReviewPartial
        ? `TP2 verdict: na — a discretionary posMonitor PARTIAL_CLOSE intervened between TP1 and the final exit. TP2 was not fairly tested; the bot's judgment ended the trade, not TP2 being unreachable. Set tp2Verdict="na".`
        : isStrongTrend
        ? `TP2 verdict (BRANCH 2, STRONG_TREND): TP1 was captured; remainder exited at ratcheted SL. Was TP2 set too far? STRONG_TREND data shows a 3–8% dead zone where price rarely continues to TP2 after TP1. TP2 was ${tp2Price > 0 ? ((isLong ? tp2Price - input.entryPrice : input.entryPrice - tp2Price) / input.entryPrice * 100).toFixed(2) : "?"}% from entry; max profit was ${maxProfitPct.toFixed(2)}%. too_ambitious = TP2 was beyond the realistic run given this regime (should be ≤6% for STRONG_TREND shorts); good = TP2 was reasonable, price simply reversed before reaching it.`
        : `TP2 verdict (BRANCH 2, regime=${entryRegime}): TP1 was captured; remainder exited at ratcheted SL before TP2. Was TP2 too ambitious? TP2 was ${tp2Price > 0 ? ((isLong ? tp2Price - input.entryPrice : input.entryPrice - tp2Price) / input.entryPrice * 100).toFixed(2) : "?"}% from entry; max profit was ${maxProfitPct.toFixed(2)}%. too_ambitious = TP2 was unrealistically far given available move; good = TP2 was reasonable, price simply reversed.`)
      : `TP2 verdict: too_tight (hit quickly, price ran far further), good (reasonable), too_ambitious (never reached despite available profit)`,
    ``,
    `═══ PARTIAL CLOSE ASSESSMENT ═══`,
    `Exit method: ${exitMethod}`,
    `Partials: ${memPartials.length > 0 ? memPartials.map(p => `${p.partialType}@$${parseFloat(p.priceAtClose ?? "0").toFixed(4)} (${p.pnlPct ?? "?"}%)`).join(", ") : "none"}`,
    `Price 4h after exit: ${fmt2(immediateReactionPct)}% | 24h: ${fmt2(fullMove24hPct)}%`,
    `Verdict needed: correct (reduced risk at right time), too_early (missed larger gain), too_late (gave back profit), na (no partials)`,
    ``,
    reconstruction ? [
      `═══ RECONSTRUCTED FORWARD OUTCOME ═══`,
      exitMethod === "manual_full"
        ? `After the human closed the FULL position early (before TP1), a 15m walk-forward was run.`
        : `After the human closed the remainder early (after bot TP1 partial), a 15m walk-forward was run.`,
      exitMethod === "manual_full"
        ? `Original SL: $${slVal.toFixed(4)}${tp1Val > 0 ? ` | TP1 target: $${tp1Val.toFixed(4)}` : ""}${tp2Val > 0 ? ` | TP2 target: $${tp2Val.toFixed(4)}` : ""}`
        : `Ratcheted SL (post-TP1): $${(input.direction === "long" ? input.entryPrice * 1.01 : input.entryPrice * 0.99).toFixed(4)} | TP2 target: $${tp2Val.toFixed(4)}`,
      `Result: ${reconstruction.outcome}${reconstruction.hitAt ? ` — hit at ${toSGT(reconstruction.hitAt)}` : ""}${reconstruction.hitPrice ? ` ($${reconstruction.hitPrice.toFixed(4)})` : ""} (walked ${reconstruction.candlesWalked} × 15m candles)`,
      reconstruction.outcome === "inconclusive_review"
        ? `No level hit within ~50h after close. Use "neutral" for manualCloseVerdict.`
        : reconstruction.outcome === "ambiguous_excluded"
        ? `A TP and SL hit on the same candle — ambiguous. Use "neutral" for manualCloseVerdict.`
        : reconstruction.outcome === "tp2_hit"
        ? `TP2 was hit → position WOULD have run to full target. Early close was premature.`
        : reconstruction.outcome === "tp1_hit"
        ? `TP1 was hit → position WOULD have reached first target. Early close was premature.`
        : `SL was hit → position WOULD have stopped out. Early close protected capital.`,
      ``,
    ].join("\n") : null,
    `═══ MANUAL CLOSE ASSESSMENT ═══`,
    ["review","manual_full","manual_partial"].includes(exitMethod)
      ? [`Trade closed by ${
           exitMethod === "review"          ? "posMonitor review (Claude decision)" :
           exitMethod === "manual_partial"  ? "human — manual close (prior bot TP1 partial existed)" :
                                             "human — full manual close (no prior bot partials)"
         } — not by exchange SL/TP.`,
         `Price 4h after close: ${fmt2(immediateReactionPct)}%`,
         `Price 24h after close: ${fmt2(fullMove24hPct)}%`,
         `Verdict needed: correct (price reversed — right call), wrong (price continued in our direction — should have held), neutral (<1% move), na`].join("\n")
      : `Exit method was ${exitMethod} — no manual close to assess. Use "na".`,
    ``,
    `═══ OPTIMAL TRADE HINDSIGHT ═══`,
    `Using ALL data (pre-trade candles, entry candle, trade period, post-exit candles), provide hindsight assessment:`,
    `- optimalEntryPrice: best entry price based on pre-trade structure and entry candle`,
    `- optimalSlPrice: SL that would not have been hit by noise but still limits loss`,
    `- optimalTp1Price: TP1 that was realistically reachable (based on actual max profit ${maxProfitPct.toFixed(2)}%)`,
    `- optimalPnlPct: P/L% achievable with optimal execution`,
    `- opportunityCostPct: optimalPnlPct minus actual P/L (${input.pnlPct.toFixed(2)}%) — positive means profit left on table`,
    `- profitMissedPct: profit missed specifically due to execution (missed TP triggers, premature exits)`,
    ``,
    `Review ALL candle data above with hindsight. Return ONLY valid JSON (no markdown):`,
    `{"entryQuality":"good|ok|poor","directionCorrect":true,"entryTiming":"early|middle|late",`,
    `"entryTimingVerdict":"early|good|late|wrong","slTooTight":false,"slTooWide":false,`,
    `"tp1Verdict":"too_tight|good|too_ambitious","tp2Verdict":"too_tight|good|too_ambitious|na",`,
    `"partialTiming":"correct|too_early|too_late|na","manualCloseVerdict":"correct|wrong|neutral|na",`,
    `"profitMissedPct":null,"optimalEntryPrice":null,"optimalSlPrice":null,`,
    `"optimalTp1Price":null,"optimalPnlPct":null,"opportunityCostPct":null,`,
    `"entryCandleQuality":"strong|neutral|weak","entryVolumeConfirmed":true,`,
    `"preTradeWarningsMissed":["string"],"preTradeConfirmationsPresent":["string"],`,
    `"slPlacement":"good|too_tight|too_wide","tpRealism":"good|too_tight|too_ambitious",`,
    `"slWasCorrect":true,"tpWasConservative":false,"missedGainPct":null,"continuedLossPct":null,`,
    `"sizingCorrect":true,"partialsCorrect":true,"marketContextCorrect":true,`,
    `"mistakeType":"wrong_direction|late_entry|stop_too_tight|stop_too_wide|chasing_extended_move|gave_back_profits|cut_winner_early|position_review_interference|stale_metadata_bug|correct_but_unlucky|null",`,
    `"signalsThatWorked":["specific signal name"],"signalsThatFailed":["specific signal name"],`,
    `"signalAccuracyInsight":"one sentence about which signals to trust more/less",`,
    `"candlePatternLesson":"specific candle pattern lesson from this trade",`,
    `"versionBLesson":"string or null","whatWorked":"string","whatDidnt":"string",`,
    `"lessonsLearned":"one concrete insight","nextTimeWouldDo":"one specific change"}`,
  ].filter(s => s !== null && s !== undefined && s !== "").join("\n");

  type R = {
    entryQuality: string; directionCorrect: boolean; entryTiming: string;
    entryCandleQuality: string; entryVolumeConfirmed: boolean;
    preTradeWarningsMissed: string[]; preTradeConfirmationsPresent: string[];
    slPlacement: string; tpRealism: string;
    slWasCorrect: boolean | string; tpWasConservative: boolean | string;
    missedGainPct: number | null; continuedLossPct: number | null;
    sizingCorrect: boolean; partialsCorrect: boolean | string;
    marketContextCorrect: boolean; mistakeType: string | null;
    signalsThatWorked: string[]; signalsThatFailed: string[];
    signalAccuracyInsight: string; candlePatternLesson: string;
    versionBLesson: string | null;
    whatWorked: string; whatDidnt: string; lessonsLearned: string; nextTimeWouldDo: string;
    entryTimingVerdict: string;
    slTooTight: boolean; slTooWide: boolean;
    tp1Verdict: string; tp2Verdict: string;
    partialTiming: string; manualCloseVerdict: string;
    profitMissedPct: number | null;
    optimalEntryPrice: number | null; optimalSlPrice: number | null;
    optimalTp1Price: number | null; optimalPnlPct: number | null;
    opportunityCostPct: number | null;
  };

  const res = await llm.json<R>({
    taskType:      "trade_reflection",
    systemContext: "You are a trading journal assistant. Reply JSON only. Be specific about signal names and prices. No markdown, no generic advice.",
    prompt,
    schema: {
      type: "object",
      required: ["entryQuality", "directionCorrect", "entryTiming", "slPlacement", "tpRealism",
                 "entryCandleQuality", "preTradeWarningsMissed", "preTradeConfirmationsPresent",
                 "signalsThatWorked", "signalsThatFailed", "candlePatternLesson",
                 "signalAccuracyInsight", "whatWorked", "whatDidnt", "lessonsLearned", "nextTimeWouldDo",
                 "entryTimingVerdict", "slTooTight", "slTooWide", "tp1Verdict", "tp2Verdict",
                 "partialTiming", "manualCloseVerdict"],
      properties: {
        entryQuality:                 { type: "string" },
        directionCorrect:             { type: "boolean" },
        entryTiming:                  { type: "string" },
        entryCandleQuality:           { type: "string" },
        entryVolumeConfirmed:         { type: "boolean" },
        preTradeWarningsMissed:       { type: "array", items: { type: "string" } },
        preTradeConfirmationsPresent: { type: "array", items: { type: "string" } },
        slPlacement:                  { type: "string" },
        tpRealism:                    { type: "string" },
        slWasCorrect:                 {},
        tpWasConservative:            {},
        missedGainPct:                {},
        continuedLossPct:             {},
        sizingCorrect:                { type: "boolean" },
        partialsCorrect:              {},
        marketContextCorrect:         { type: "boolean" },
        mistakeType:                  {},
        signalsThatWorked:            { type: "array", items: { type: "string" } },
        signalsThatFailed:            { type: "array", items: { type: "string" } },
        signalAccuracyInsight:        { type: "string" },
        candlePatternLesson:          { type: "string" },
        versionBLesson:               {},
        whatWorked:                   { type: "string" },
        whatDidnt:                    { type: "string" },
        lessonsLearned:               { type: "string" },
        nextTimeWouldDo:              { type: "string" },
        entryTimingVerdict:           { type: "string" },
        slTooTight:                   { type: "boolean" },
        slTooWide:                    { type: "boolean" },
        tp1Verdict:                   { type: "string" },
        tp2Verdict:                   { type: "string" },
        partialTiming:                { type: "string" },
        manualCloseVerdict:           { type: "string" },
        profitMissedPct:              {},
        optimalEntryPrice:            {},
        optimalSlPrice:               {},
        optimalTp1Price:              {},
        optimalPnlPct:                {},
        opportunityCostPct:           {},
      },
    },
    fallback: {
      entryQuality: "ok", directionCorrect: true, entryTiming: "middle",
      entryCandleQuality: "neutral", entryVolumeConfirmed: false,
      preTradeWarningsMissed: [], preTradeConfirmationsPresent: [],
      slPlacement: "good", tpRealism: "good",
      slWasCorrect: "na", tpWasConservative: false,
      missedGainPct: null, continuedLossPct: null,
      sizingCorrect: true, partialsCorrect: "na", marketContextCorrect: true,
      mistakeType: null, signalsThatWorked: [], signalsThatFailed: [],
      signalAccuracyInsight: "", candlePatternLesson: "",
      versionBLesson: null, whatWorked: "", whatDidnt: "", lessonsLearned: "", nextTimeWouldDo: "",
      entryTimingVerdict: "good", slTooTight: false, slTooWide: false,
      tp1Verdict: "good", tp2Verdict: "good", partialTiming: "na",
      manualCloseVerdict: "na", profitMissedPct: null, optimalEntryPrice: null,
      optimalSlPrice: null, optimalTp1Price: null, optimalPnlPct: null, opportunityCostPct: null,
    },
  });

  const d = res.data;

  // Hard override — Branch 2 (ratcheted SL after TP1) and Branch 3 (TP exit) must never
  // be labeled slTooTight regardless of what the LLM returns. The original entry SL was
  // never hit in these cases; the label is not applicable.
  if (exitBranch === "ratcheted_sl" || exitBranch === "tp_hit") {
    d.slTooTight = false;
  }

  // Hard override — a discretionary posMonitor PARTIAL_CLOSE between TP1 and final exit means
  // TP2 was not fairly tested. The bot's judgment ended the trade; TP2 distance is not the signal.
  if (exitBranch === "ratcheted_sl" && tp1Executed && hadReviewPartial) {
    d.tp2Verdict = "na";
  }

  const outcome    = input.pnl >= 0 ? "WIN" : "LOSS";
  const reflection = [
    `${input.direction.toUpperCase()} ${outcome} ${sign}${input.pnlPct.toFixed(2)}%`,
    d.mistakeType && d.mistakeType !== "null" ? `mistake=${d.mistakeType}` : null,
    d.lessonsLearned || null,
  ].filter(Boolean).join(" | ");

  const slWasCorrectBool = d.slWasCorrect === "na" ? null
    : d.slWasCorrect === true || d.slWasCorrect === "true";
  const tpWasConservativeBool = d.tpWasConservative === "na" ? null
    : d.tpWasConservative === true || d.tpWasConservative === "true";

  await db.insert(tradeMemoryTable).values({
    symbol:               input.symbol,
    action:               "TRADE_CLOSE",
    pnlPct:               String(input.pnlPct.toFixed(4)),
    sourceTradeId:        input.sourceTradeId ?? null,
    reflection,
    entryQuality:         String(d.entryQuality),
    directionCorrect:     String(d.directionCorrect),
    entryTiming:          d.entryTiming          || null,
    slPlacement:          d.slPlacement          || null,
    tpRealism:            d.tpRealism            || null,
    sizingCorrect:        String(d.sizingCorrect),
    partialsCorrect:      String(d.partialsCorrect),
    marketContextCorrect: String(d.marketContextCorrect),
    mistakeType:          (d.mistakeType && d.mistakeType !== "null") ? d.mistakeType : null,
    signalsThatWorked:    JSON.stringify(d.signalsThatWorked || []),
    signalsThatFailed:    JSON.stringify(d.signalsThatFailed || []),
    versionBLesson:       d.versionBLesson       || null,
    whatWorked:           d.whatWorked           || null,
    whatDidnt:            d.whatDidnt            || null,
    lessonsLearned:       d.lessonsLearned       || null,
    nextTimeWouldDo:      d.nextTimeWouldDo      || null,
    // Execution quality tracking — code-computed only; LLM cannot overwrite these fields.
    failureType:            failureType,
    executionIssues:        executionIssues,
    tp1Reached,
    tp2Reached,
    maxProfitPct:           String(maxProfitPct.toFixed(4)),
    profitProtectionMissed: false,
    slippagePct:            String(slippage.toFixed(4)),
    excessivePartials:      memPartials.length > 3,
    exitMethod,
    metadataWasStale:       false,
    // Candle & signal analysis
    entryCandleQuality:     d.entryCandleQuality     || null,
    entryVolumeConfirmed:   typeof d.entryVolumeConfirmed === "boolean" ? d.entryVolumeConfirmed : null,
    preTradeWarningsMissed: d.preTradeWarningsMissed?.length  ? d.preTradeWarningsMissed  : null,
    preTradeConfirmations:  d.preTradeConfirmationsPresent?.length ? d.preTradeConfirmationsPresent : null,
    slWasCorrect:           slWasCorrectBool,
    tpWasConservative:      tpWasConservativeBool,
    missedGainPct:          d.missedGainPct    != null ? String((d.missedGainPct as number).toFixed(4))    : (additionalGainPct > 0 ? String(additionalGainPct.toFixed(4)) : null),
    continuedLossPct:       d.continuedLossPct != null ? String((d.continuedLossPct as number).toFixed(4)) : (maxAdditionalLossPct > 0 ? String(maxAdditionalLossPct.toFixed(4)) : null),
    candlePatternLesson:    d.candlePatternLesson    || null,
    signalAccuracyInsight:  d.signalAccuracyInsight  || null,
    btcContextPre,
    btcContextPost,
    price1hAfter:           price1hAfter  > 0 ? String(price1hAfter)  : null,
    price4hAfter:           price4hAfter  > 0 ? String(price4hAfter)  : null,
    price24hAfter:          price24hAfter > 0 ? String(price24hAfter) : null,
    // Structured verdict fields — batch 5
    entryTimingVerdict:     d.entryTimingVerdict  || null,
    slTooTight:             typeof d.slTooTight  === "boolean" ? d.slTooTight  : null,
    slTooWide:              typeof d.slTooWide   === "boolean" ? d.slTooWide   : null,
    tp1Verdict:             d.tp1Verdict         || null,
    tp2Verdict:             d.tp2Verdict         || null,
    partialTiming:          d.partialTiming      || null,
    manualCloseVerdict:     d.manualCloseVerdict || null,
    profitMissedPct:        d.profitMissedPct   != null ? String((d.profitMissedPct   as number).toFixed(4)) : null,
    optimalEntryPrice:      d.optimalEntryPrice != null ? String((d.optimalEntryPrice as number).toFixed(8)) : null,
    optimalSlPrice:         d.optimalSlPrice    != null ? String((d.optimalSlPrice    as number).toFixed(8)) : null,
    optimalTp1Price:        d.optimalTp1Price   != null ? String((d.optimalTp1Price   as number).toFixed(8)) : null,
    optimalPnlPct:          d.optimalPnlPct     != null ? String((d.optimalPnlPct     as number).toFixed(4)) : null,
    opportunityCostPct:     d.opportunityCostPct != null ? String((d.opportunityCostPct as number).toFixed(4)) : null,
    tp2ProgressPct:         tp2ProgressPct !== null ? String(tp2ProgressPct.toFixed(4)) : null,
    source:                 input.source ?? null,
    // Phase 3 reconstruction
    pnlSource:            reconstruction
      ? (reconstruction.outcome === "ambiguous_excluded" ? "ambiguous_excluded" : "reconstructed")
      : exitMethod === "sl_hit" || exitMethod === "tp_hit" ? "actual"
      : null,
    reconstructedOutcome: reconstruction?.outcome !== "ambiguous_excluded" ? reconstruction?.outcome ?? null : null,
  });

  // Alert on execution failures (suppressed for backfill runs)
  if (executionIssues.length > 0 && _ruleAlertFn && !input.suppressAlerts) {
    const resultLabel = tradeLost ? "LOSS" : "WIN";
    const msg = [
      `⚠️ <b>Execution issue — ${input.symbol}</b>`,
      `Issues: ${executionIssues.join(", ")}`,
      `Trade result: ${resultLabel} ${input.pnlPct >= 0 ? "+" : ""}${input.pnlPct.toFixed(2)}%`,
      ``,
      failureType === "execution"
        ? "Strategy was correct — system bug needs a fix"
        : failureType === "success"
        ? "Note: slippage on a winning trade — monitor fill quality"
        : "Mixed: strategy + execution issues",
    ].join("\n");
    _ruleAlertFn(msg).catch(() => {});
  }

  // Fix 5: Log reflection quality fields
  const isComplete = !!(d.lessonsLearned && d.whatWorked && d.whatDidnt && d.nextTimeWouldDo);
  console.log(
    `[reflection] ${input.symbol} complete=${isComplete}` +
    ` entryQuality=${!!d.entryQuality} lessonsLearned=${!!d.lessonsLearned}` +
    ` whatWorked=${!!d.whatWorked} nextTime=${!!d.nextTimeWouldDo}`
  );
  console.log(`[tradeMemory] ${input.symbol} reflection stored — ${outcome} ${sign}${input.pnlPct.toFixed(2)}% mistake=${d.mistakeType ?? "none"}`);

  if (!isComplete) {
    if (_retryCount < 2) {
      console.error(`[reflection] INCOMPLETE — ${input.symbol} missing critical fields. Retry ${_retryCount + 1}/2 in 60 seconds.`);
      setTimeout(() => {
        generateReflection(input, _retryCount + 1).catch(e =>
          console.error(`[reflection] retry failed for ${input.symbol}:`, (e as Error).message)
        );
      }, 60_000);
    } else {
      console.error(`[reflection] INCOMPLETE — ${input.symbol} gave up after 2 retries. Accepting partial reflection.`);
    }
  }
}

// ─── Partial close logger ─────────────────────────────────────────────────────

export async function logPartialClose(params: {
  symbol:       string;
  partialType:  "tp1" | "tp2" | "large_profit" | "review" | "review_partial";
  closePct:     number;
  priceAtClose: number;
  pnlPct:       number;
  remainingPct: number;
}): Promise<void> {
  const { symbol, partialType, closePct, priceAtClose, pnlPct, remainingPct } = params;
  const sign = pnlPct >= 0 ? "+" : "";
  await db.insert(tradeMemoryTable).values({
    symbol,
    action:       "PARTIAL",
    partialType,
    closePct:     String(closePct),
    priceAtClose: String(priceAtClose.toFixed(4)),
    remainingPct: String(remainingPct),
    pnlPct:       String(pnlPct.toFixed(4)),
    reflection:   `PARTIAL ${partialType.toUpperCase()}: closed ${closePct}% at $${priceAtClose.toFixed(4)} (${sign}${pnlPct.toFixed(2)}%), ${remainingPct}% remaining`,
  }).catch(e => console.error("[tradeMemory] logPartialClose failed:", e));
}

// ─── Phase 3: Forward reconstruction ─────────────────────────────────────────
// Walk 15m candles forward from manual close to assess whether the bot's TP2
// or ratcheted SL would have been hit if the remainder ran to natural exit.
// Only called for manual_partial exits with a valid tp2 target.
export type ReconstructionResult = {
  outcome:       "tp1_hit" | "tp2_hit" | "sl_hit" | "inconclusive_review" | "ambiguous_excluded";
  candlesWalked: number;
  hitAt?:        Date;
  hitPrice?:     number;
};

export async function reconstructForwardFromClose(params: {
  symbol:    string;
  direction: "long" | "short";
  sl:        number;   // ratcheted SL for manual_partial; original SL for manual_full
  tp1?:      number;   // only passed for manual_full (TP1 never fired)
  tp2?:      number;   // passed for both when available
  startAt:   Date;
}): Promise<ReconstructionResult> {
  const { symbol, direction, sl, tp1, tp2, startAt } = params;
  const candles = await fetchKlines({ symbol, interval: "15", start: startAt, limit: 200 });

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const tp1Hit = tp1 ? (direction === "long" ? c.high >= tp1 : c.low  <= tp1) : false;
    const tp2Hit = tp2 ? (direction === "long" ? c.high >= tp2 : c.low  <= tp2) : false;
    const slHit  =       direction === "long" ? c.low  <= sl  : c.high >= sl;

    // TP + SL same candle — can't tell which came first
    if ((tp1Hit || tp2Hit) && slHit) {
      return { outcome: "ambiguous_excluded", candlesWalked: i + 1, hitAt: new Date(c.ts) };
    }
    // TP1 + TP2 same candle → tp2_hit (price ran through both, most favorable)
    if (tp2Hit) {
      return { outcome: "tp2_hit", candlesWalked: i + 1, hitAt: new Date(c.ts), hitPrice: tp2 };
    }
    if (tp1Hit) {
      return { outcome: "tp1_hit", candlesWalked: i + 1, hitAt: new Date(c.ts), hitPrice: tp1 };
    }
    if (slHit) {
      return { outcome: "sl_hit",  candlesWalked: i + 1, hitAt: new Date(c.ts), hitPrice: sl };
    }
  }

  return { outcome: "inconclusive_review", candlesWalked: candles.length };
}

// ─── Manual-close detection ───────────────────────────────────────────────────
// Resolves the true exit reason for a position close by mechanism:
// 1. Looks up stopOrderType on the final close order → definitive for exchange SL/TP
// 2. For plain Market orders, checks trade_memory for bot PARTIAL records → manual if none found
export async function resolveExitReason(params: {
  symbol:   string;
  orderId:  string;
  entryAt?: Date;
  exitAt?:  Date;
}): Promise<string> {
  const stopType = await getOrderStopType(params.symbol, params.orderId).catch(() => "");
  if (stopType === "StopLoss")          return "sl_hit";
  if (stopType === "TakeProfit")        return "tp_hit";
  if (stopType === "PartialTakeProfit") return "tp_hit";
  // Market order — check for bot TP1/TP2 PARTIAL records in trade window
  if (params.entryAt && params.exitAt) {
    const windowStart = new Date(params.entryAt.getTime() - 30 * 60_000);
    const windowEnd   = new Date(params.exitAt.getTime()  + 30 * 60_000);
    const partials = await db.select({ partialType: tradeMemoryTable.partialType })
      .from(tradeMemoryTable)
      .where(and(
        eq(tradeMemoryTable.symbol,     params.symbol),
        eq(tradeMemoryTable.action,     "PARTIAL"),
        gte(tradeMemoryTable.createdAt, windowStart),
        lte(tradeMemoryTable.createdAt, windowEnd),
      ))
      .catch(() => [] as { partialType: string | null }[]);
    if (partials.some(p => p.partialType === "tp1" || p.partialType === "tp2"))
      return "manual_partial";
  }
  return "manual_full";
}

// ─── Trading rules helpers ────────────────────────────────────────────────────

export async function getActiveRules(): Promise<TradingRule[]> {
  return db.select()
    .from(tradingRulesTable)
    .where(eq(tradingRulesTable.active, true))
    .orderBy(asc(tradingRulesTable.ruleNumber))
    .catch(() => [] as TradingRule[]);
}

async function getLastRuleGenerationDate(): Promise<Date> {
  const [row] = await db.select({ updatedAt: tradingRulesTable.updatedAt })
    .from(tradingRulesTable)
    .orderBy(desc(tradingRulesTable.updatedAt))
    .limit(1)
    .catch(() => []);
  return row?.updatedAt ?? new Date(0);
}

async function updateRuleStatsForTrade(won: boolean, tradeId: string): Promise<void> {
  const [trade] = await db.select({ appliedRuleIds: tradeLogTable.appliedRuleIds })
    .from(tradeLogTable)
    .where(eq(tradeLogTable.id, tradeId))
    .catch(() => []);

  const ruleIds = trade?.appliedRuleIds as number[] | null;
  if (!ruleIds?.length) {
    console.log(`[rules] Trade ${tradeId} has no appliedRuleIds — skipping rule stat update`);
    return;
  }

  for (const ruleId of ruleIds) {
    const [rule] = await db.select()
      .from(tradingRulesTable)
      .where(eq(tradingRulesTable.id, ruleId))
      .limit(1)
      .catch(() => []);
    if (!rule) continue;
    const update = won
      ? { winsFollowing: rule.winsFollowing + 1, updatedAt: new Date() }
      : { lossesFollowing: rule.lossesFollowing + 1, updatedAt: new Date() };
    await db.update(tradingRulesTable)
      .set(update)
      .where(eq(tradingRulesTable.id, ruleId))
      .catch(() => {});
    console.log(`[rules] Rule ${rule.ruleNumber} ${won ? "WIN" : "LOSS"} — now ${rule.winsFollowing + (won ? 1 : 0)}W/${rule.lossesFollowing + (won ? 0 : 1)}L`);
  }
}

async function updatePendingOverrides(symbol: string, pnlPct: number): Promise<void> {
  const pending = await db.select()
    .from(ruleOverridesTable)
    .where(and(eq(ruleOverridesTable.symbol, symbol), eq(ruleOverridesTable.tradeResult, "pending")))
    .catch(() => [] as typeof ruleOverridesTable.$inferSelect[]);

  for (const override of pending) {
    const [rule] = await db.select()
      .from(tradingRulesTable)
      .where(eq(tradingRulesTable.id, override.ruleId))
      .limit(1)
      .catch(() => []);
    if (!rule) continue;

    const won = pnlPct > 0;
    const levels = ["LOW", "MEDIUM", "HIGH"] as const;
    const curIdx  = levels.indexOf(rule.confidence as typeof levels[number]);
    const newIdx  = won
      ? Math.max(0, curIdx - 1)   // override + WIN  → confidence drops (rule was probably right)
      : Math.min(2, curIdx + 1);  // override + LOSS → confidence rises (rule was validated)
    const newConf = levels[newIdx]!;

    await db.update(ruleOverridesTable)
      .set({ tradeResult: won ? "win" : "loss", pnlPct: String(pnlPct.toFixed(4)), confidenceAfter: newConf })
      .where(eq(ruleOverridesTable.id, override.id))
      .catch(() => {});

    if (newConf !== rule.confidence) {
      await db.update(tradingRulesTable)
        .set({ confidence: newConf, updatedAt: new Date() })
        .where(eq(tradingRulesTable.id, rule.id))
        .catch(() => {});
      console.log(`[rules] Rule ${rule.ruleNumber} confidence: ${rule.confidence} → ${newConf} (override ${won ? "won" : "lost"} on ${symbol})`);
    }
  }
}

export async function generateTradingRules(force = false): Promise<void> {
  // Only generate if 20+ new closed trades since last generation (bypassed by force)
  const lastGenDate = await getLastRuleGenerationDate();
  const newTrades   = await db.select({ id: tradeLogTable.id })
    .from(tradeLogTable)
    .where(and(isNotNull(tradeLogTable.exitAt), gt(tradeLogTable.exitAt, lastGenDate)))
    .catch(() => [] as Array<{ id: string }>);

  if (!force && newTrades.length < 20) {
    console.log(`[rules] Only ${newTrades.length}/20 new trades since last generation — skipping`);
    return;
  }

  // Live-era only: all testnet trades closed before 2026-06-04 (confirmed switchover date).
  // Paper trades (integer source_trade_id) are currently all pre-cutoff; if a future paper trade
  // gets sl_hit/tp_hit after this date, add a NOT SIMILAR TO '[0-9]+' guard here.
  const reflections = await db.select()
    .from(tradeMemoryTable)
    .where(and(
      eq(tradeMemoryTable.action,     "TRADE_CLOSE"),
      inArray(tradeMemoryTable.exitMethod, ["sl_hit", "tp_hit"]),
      gte(tradeMemoryTable.createdAt,  new Date('2026-06-04T00:00:00Z')),
    ))
    .orderBy(desc(tradeMemoryTable.createdAt))
    .catch(() => [] as typeof tradeMemoryTable.$inferSelect[]);

  if (reflections.length < 10) {
    console.log(`[rules] Insufficient reflections (${reflections.length}) — skipping`);
    return;
  }



  // Verdict aggregates from batch-5 fields (computed over all reflections, not just strategy)
  const N = reflections.length;
  const slTightCount = reflections.filter(r => r.slTooTight === true).length;
  const slWideCount  = reflections.filter(r => r.slTooWide  === true).length;
  const tp1VerdictCounts:     Record<string, number> = {};
  const tp2VerdictCounts:     Record<string, number> = {};
  const entryTimingCounts:    Record<string, number> = {};
  const partialTimingCounts:  Record<string, number> = {};
  const failureTypeCounts:    Record<string, number> = {};
  let profitMissedSum = 0, profitMissedCount = 0;
  let opCostSum = 0,       opCostCount = 0;
  for (const r of reflections) {
    if (r.tp1Verdict)                                    tp1VerdictCounts[r.tp1Verdict]         = (tp1VerdictCounts[r.tp1Verdict]         ?? 0) + 1;
    if (r.tp2Verdict      && r.tp2Verdict      !== "na") tp2VerdictCounts[r.tp2Verdict]         = (tp2VerdictCounts[r.tp2Verdict]         ?? 0) + 1;
    if (r.entryTimingVerdict)                            entryTimingCounts[r.entryTimingVerdict] = (entryTimingCounts[r.entryTimingVerdict] ?? 0) + 1;
    if (r.partialTiming   && r.partialTiming   !== "na") partialTimingCounts[r.partialTiming]    = (partialTimingCounts[r.partialTiming]    ?? 0) + 1;
    if (r.failureType)                                   failureTypeCounts[r.failureType]        = (failureTypeCounts[r.failureType]        ?? 0) + 1;
    if (r.profitMissedPct   != null) { profitMissedSum += parseFloat(String(r.profitMissedPct));   profitMissedCount++; }
    if (r.opportunityCostPct != null) { opCostSum       += parseFloat(String(r.opportunityCostPct)); opCostCount++;       }
  }
  const topFailureType  = Object.entries(failureTypeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
  const avgProfitMissed = profitMissedCount > 0 ? (profitMissedSum / profitMissedCount).toFixed(2) : "n/a";
  const avgOpCost       = opCostCount       > 0 ? (opCostSum       / opCostCount      ).toFixed(2) : "n/a";
  const fmtCounts = (m: Record<string, number>) => Object.entries(m).sort((a,b) => b[1]-a[1]).map(([k,v]) => `${k}=${v}`).join(", ") || "no data";
  const verdictAggregates = [
    `VERDICT AGGREGATES (last ${N} trades):`,
    `- SL too tight: ${slTightCount}/${N} trades`,
    `- SL too wide:  ${slWideCount}/${N} trades`,
    `- TP1 verdict:  ${fmtCounts(tp1VerdictCounts)}`,
    `- TP2 verdict:  ${fmtCounts(tp2VerdictCounts)}`,
    `- Entry timing: ${fmtCounts(entryTimingCounts)}`,
    `- Partial timing: ${fmtCounts(partialTimingCounts)}`,
    `- Avg profit missed: ${avgProfitMissed}%`,
    `- Avg opportunity cost: ${avgOpCost}%`,
    `- Most common failure type: ${topFailureType}`,
  ].join("\n");

  const reflStr = reflections.map(r => {
    const pct = parseFloat(r.pnlPct ?? "0");
    const slVerdict = r.slTooTight ? "too_tight" : r.slTooWide ? "too_wide" : null;
    return [
      `${r.symbol} | P/L: ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
      r.entryQuality        ? `  Entry: ${r.entryQuality} timing=${r.entryTiming}` : "",
      r.entryTimingVerdict  ? `  EntryVerdict: ${r.entryTimingVerdict}` : "",
      slVerdict             ? `  SL: ${slVerdict}` : "",
      r.tp1Verdict          ? `  TP1Verdict: ${r.tp1Verdict}` : "",
      r.tp2Verdict          ? `  TP2Verdict: ${r.tp2Verdict}` : "",
      r.opportunityCostPct != null ? `  OpportunityCost: ${parseFloat(String(r.opportunityCostPct)).toFixed(2)}%` : "",
      r.mistakeType         ? `  Mistake: ${r.mistakeType}` : "",
      r.signalsThatWorked   ? `  Worked: ${r.signalsThatWorked}` : "",
      r.signalsThatFailed   ? `  Failed: ${r.signalsThatFailed}` : "",
      r.lessonsLearned      ? `  Lesson: ${r.lessonsLearned}` : "",
      r.nextTimeWouldDo     ? `  Next: ${r.nextTimeWouldDo}` : "",
      r.failureType         ? `  Type: ${r.failureType}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n---\n");

  const prompt = [
    `Analyse trade reflections and generate between 5 and 15 actionable trading rules — as many as the evidence supports with minimum 3 trade occurrences each. Do not invent rules to fill a quota.`,
    ``,
    verdictAggregates,
    ``,
    `Rules derived from VERDICT AGGREGATES must be specific and quantified.`,
    `Good: "SL was too tight in 7/10 losses — widen SL to 2.0× ATR minimum"`,
    `Bad:  "Consider SL placement more carefully"`,
    `Good: "TP1 too_ambitious in 8/12 trades — set TP1 at 1.0× ATR not 2.0×"`,
    `Bad:  "Be more realistic with TP targets"`,
    ``,
    `Analyse ALL ${reflections.length} trade reflections below for rule generation:`,
    ``,
    `Requirements per rule:`,
    `- Minimum 3 trade occurrences as evidence`,
    `- Clear causal logic (not just correlation)`,
    `- Cross-check: funding positive = longs crowded = short bias; price above EMA = bullish; high volume breakout = real move`,
    `- Flag if rule contradicts market fundamentals`,
    `- Confidence: HIGH (5+ occurrences) | MEDIUM (3-4) | LOW (<3)`,
    ``,
    `Trade reflections (${reflections.length} trades):`,
    reflStr,
    ``,
    `Return ONLY valid JSON:`,
    `{"rules":[{"ruleNumber":1,"ruleText":"specific actionable rule","evidence":"X/Y trades","causalLogic":"why","confidence":"HIGH|MEDIUM|LOW","occurrences":5,"contradictsFundamentals":false,"flagNote":null}],"patternsFound":"summary"}`,
  ].join("\n");

  type RuleGenResult = {
    rules: Array<{
      ruleNumber: number; ruleText: string; evidence: string;
      causalLogic: string; confidence: string; occurrences: number;
      contradictsFundamentals: boolean; flagNote: string | null;
    }>;
    patternsFound: string;
  };

  const isRateLimitErr = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.includes("429") || msg.includes("rate_limit") || msg.includes("rate limit") || msg.includes("usage limits");
  };

  const callLlm = () => llm.json<RuleGenResult>({
    taskType:      "rule_generation",
    systemContext: "You are a trading performance analyst. Generate evidence-based rules from trade data. Reply JSON only.",
    prompt,
    schema: { type: "object", properties: { rules: { type: "array" }, patternsFound: { type: "string" } }, required: ["rules"] },
    fallback: { rules: [], patternsFound: "" },
  });

  let res: Awaited<ReturnType<typeof callLlm>>;
  try {
    res = await callLlm();
  } catch (err) {
    if (isRateLimitErr(err)) {
      console.warn("[rules] Rate limit hit — waiting 60s then retrying");
      await new Promise(r => setTimeout(r, 60_000));
      try {
        res = await callLlm();
      } catch (retryErr) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        await _ruleAlertFn?.("⚠️ Rule generation rate-limited — try again in a few minutes").catch(() => {});
        console.error("[rules] Retry also failed:", msg);
        return;
      }
    } else {
      throw err;
    }
  }

  console.log(`[rules] Raw response: ${res.text}`);

  const validRules = res.data.rules.filter(rule => {
    if (rule.occurrences < 3) {
      console.log(`[rules] Rule ${rule.ruleNumber} insufficient evidence (${rule.occurrences}<3) — skipped`);
      return false;
    }
    if (rule.contradictsFundamentals) {
      console.log(`[rules] Rule ${rule.ruleNumber} flags fundamentals contradiction: ${rule.flagNote ?? "unspecified"}`);
    }
    return true;
  });

  // Delete all existing rules then insert fresh — no ghost entries from prior generations
  await db.delete(tradingRulesTable).catch(e => console.error("[rules] Delete existing rules:", e));

  let generated = 0;
  for (const rule of validRules) {
    await db.insert(tradingRulesTable)
      .values({
        ruleNumber:      rule.ruleNumber,
        ruleText:        rule.ruleText,
        evidence:        rule.evidence,
        causalLogic:     rule.causalLogic,
        confidence:      rule.confidence,
        occurrences:     rule.occurrences,
        winsFollowing:   0,
        lossesFollowing: 0,
        active:          true,
        createdAt:       new Date(),
        updatedAt:       new Date(),
      })
      .catch(e => console.error(`[rules] Insert rule ${rule.ruleNumber}:`, e));
    generated++;
    console.log(`[rules] Rule ${rule.ruleNumber} [${rule.confidence}]: ${rule.ruleText.slice(0, 80)}`);
  }

  console.log(`[rules] Generated/updated ${generated} rules from ${reflections.length} reflections`);
  await _ruleAlertFn?.(
    `🧠 <b>Trading rules updated (${generated} rules)</b>\nBased on ${reflections.length} trade reflections\nUse /rules to see current rules`
  ).catch(() => {});
}

async function checkAndGenerateRules(): Promise<void> {
  try {
    await generateTradingRules();
  } catch (e) {
    console.error("[rules] checkAndGenerateRules:", e);
  }
}

// ─── Recent memory for scan prompt ───────────────────────────────────────────

export async function getRecentMemory(limit = 15): Promise<string> {
  const rows = await db.select()
    .from(tradeMemoryTable)
    .orderBy(desc(tradeMemoryTable.createdAt))
    .limit(limit + 10);

  // All TRADE_CLOSE entries for pattern analysis
  const allCloses = await db.select({
    directionCorrect:     tradeMemoryTable.directionCorrect,
    entryTiming:          tradeMemoryTable.entryTiming,
    slPlacement:          tradeMemoryTable.slPlacement,
    tpRealism:            tradeMemoryTable.tpRealism,
    mistakeType:          tradeMemoryTable.mistakeType,
    entryQuality:         tradeMemoryTable.entryQuality,
    pnlPct:               tradeMemoryTable.pnlPct,
  }).from(tradeMemoryTable)
    .where(and(
      eq(tradeMemoryTable.action,    "TRADE_CLOSE"),
      gte(tradeMemoryTable.createdAt, new Date('2026-06-04T00:00:00Z')),
    ))
    .orderBy(desc(tradeMemoryTable.createdAt))
    .limit(50)
    .catch(() => [] as Array<Record<string, string | null>>);

  if (!rows.length) return "No trade memory available yet.";

  const lines: string[] = ["═══ TRADING LESSONS FROM HISTORY ═══\n"];

  // ── Recent trade closes ──
  const closes = rows.filter(r => r.action === "TRADE_CLOSE").slice(0, limit);
  if (closes.length) {
    lines.push("Recent closed trades:");
    for (const r of closes) {
      const pct  = r.pnlPct ? parseFloat(r.pnlPct) : 0;
      const sign = pct >= 0 ? "+" : "";
      const outcome = pct >= 0 ? "WIN" : "LOSS";
      lines.push(`━━━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`${r.symbol} ${r.directionCorrect === "false" ? "⚠️wrong-dir" : ""} | ${sign}${pct.toFixed(2)}% | ${outcome}`);
      if (r.entryQuality)
        lines.push(`  Entry: ${r.entryQuality} | Timing: ${r.entryTiming ?? "?"} | Dir: ${r.directionCorrect === "true" ? "✓" : "✗"} | SL: ${r.slPlacement ?? "?"} | TP: ${r.tpRealism ?? "?"}`);
      if (r.mistakeType)
        lines.push(`  Mistake: ${r.mistakeType}`);
      if (r.whatWorked)
        lines.push(`  Worked: ${r.whatWorked}`);
      if (r.whatDidnt)
        lines.push(`  Failed: ${r.whatDidnt}`);
      if (r.lessonsLearned)
        lines.push(`  Lesson: ${r.lessonsLearned}`);
      if (r.nextTimeWouldDo)
        lines.push(`  Next: ${r.nextTimeWouldDo}`);
      if (r.versionBLesson)
        lines.push(`  Version B: ${r.versionBLesson}`);
    }
  }

  // ── Recent partials ──
  const partials = rows.filter(r => r.action === "PARTIAL").slice(0, 4);
  if (partials.length) {
    lines.push(`\nRecent partial closes:`);
    for (const r of partials) {
      lines.push(`━━━━━━━━━━━━━━━━━━━━━━`);
      lines.push(r.reflection);
    }
  }

  // ── Pattern analysis ──
  if (allCloses.length > 0) {
    const total      = allCloses.length;
    const wrongDir   = allCloses.filter(r => r.directionCorrect === "false").length;
    const lateEntry  = allCloses.filter(r => r.entryTiming === "late").length;
    const tightSL    = allCloses.filter(r => r.slPlacement === "too_tight").length;
    const wins       = allCloses.filter(r => parseFloat(r.pnlPct ?? "0") > 0).length;

    const mistakeCounts: Record<string, number> = {};
    for (const r of allCloses) {
      if (r.mistakeType) mistakeCounts[r.mistakeType] = (mistakeCounts[r.mistakeType] ?? 0) + 1;
    }
    const topMistakes = Object.entries(mistakeCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k}(${v})`).join(", ");

    lines.push(`\n═══ PATTERNS IDENTIFIED ═══`);
    lines.push(`Overall: ${wins}/${total} win rate (${Math.round(wins / total * 100)}%)`);
    lines.push(`Wrong direction: ${wrongDir}/${total} (${Math.round(wrongDir / total * 100)}%)`);
    lines.push(`Late entries: ${lateEntry}/${total} (${Math.round(lateEntry / total * 100)}%)`);
    lines.push(`Stop too tight: ${tightSL}/${total} (${Math.round(tightSL / total * 100)}%)`);
    if (topMistakes) lines.push(`Top mistakes: ${topMistakes}`);
    lines.push(`\nAPPLY THESE LESSONS NOW. Do not repeat identified mistakes.`);
  }

  // ── Version B successful entries ──
  try {
    const vbWins = await db.select({
      symbol:          paperTradesTable.symbol,
      direction:       paperTradesTable.direction,
      entryPrice:      paperTradesTable.entryPrice,
      signalTime:      paperTradesTable.signalTime,
      wouldHavePnlPct: paperTradesTable.wouldHavePnlPct,
      tp1:             paperTradesTable.tp1,
      stopLoss:        paperTradesTable.stopLoss,
      whyNow:          paperTradesTable.whyNow,
    }).from(paperTradesTable)
      .where(and(
        inArray(paperTradesTable.status, ["tp1_hit", "tp2_hit"]),
        gt(paperTradesTable.wouldHavePnlPct, 2),
      ))
      .orderBy(desc(paperTradesTable.signalTime))
      .limit(5);

    if (vbWins.length) {
      lines.push(`\n═══ VERSION B SUCCESSFUL ENTRIES (learn from these) ═══`);
      for (const w of vbWins) {
        const pct = w.wouldHavePnlPct ?? 0;
        lines.push(`${w.symbol} ${w.direction} entry $${w.entryPrice.toFixed(4)} → +${pct.toFixed(2)}% (TP hit)`);
        if (w.whyNow) lines.push(`  What worked: ${w.whyNow}`);
      }
    }
  } catch { /* non-fatal */ }

  // ── Signal accuracy summary ──
  try {
    const sigRows = await db.select({
      signalsThatWorked: tradeMemoryTable.signalsThatWorked,
      signalsThatFailed: tradeMemoryTable.signalsThatFailed,
    }).from(tradeMemoryTable)
      .where(and(
        eq(tradeMemoryTable.action,    "TRADE_CLOSE"),
        gte(tradeMemoryTable.createdAt, new Date('2026-06-04T00:00:00Z')),
      ))
      .orderBy(desc(tradeMemoryTable.createdAt))
      .limit(50);

    const acc: Record<string, { worked: number; failed: number }> = {};
    for (const row of sigRows) {
      for (const s of JSON.parse(row.signalsThatWorked ?? "[]") as string[]) {
        if (!acc[s]) acc[s] = { worked: 0, failed: 0 };
        acc[s].worked++;
      }
      for (const s of JSON.parse(row.signalsThatFailed ?? "[]") as string[]) {
        if (!acc[s]) acc[s] = { worked: 0, failed: 0 };
        acc[s].failed++;
      }
    }

    if (Object.keys(acc).length > 0) {
      const sorted = Object.entries(acc)
        .map(([sig, s]) => ({ sig, total: s.worked + s.failed, pct: s.worked / (s.worked + s.failed) * 100 }))
        .sort((a, b) => b.pct - a.pct);

      lines.push(`\n═══ YOUR SIGNAL ACCURACY (from trade history) ═══`);
      for (const { sig, total, pct } of sorted) {
        const reliability = pct >= 60 ? "✅ reliable" : pct >= 40 ? "⚠️ mixed" : "❌ unreliable";
        lines.push(`${sig}: ${pct.toFixed(0)}% (${total} trades) ${reliability}`);
      }
      const top    = sorted.slice(0, 3).map(s => s.sig).join(", ");
      const bottom = sorted.slice(-3).reverse().map(s => s.sig).join(", ");
      if (top)    lines.push(`Most reliable signals (use these): ${top}`);
      if (bottom) lines.push(`Least reliable signals (question these): ${bottom}`);
      lines.push(`Apply this knowledge to current scan decisions.`);
    }
  } catch { /* non-fatal */ }

  // ── Candle pattern lessons ──
  try {
    const patternRows = await db.select({
      symbol:                 tradeMemoryTable.symbol,
      candlePatternLesson:    tradeMemoryTable.candlePatternLesson,
      preTradeWarningsMissed: tradeMemoryTable.preTradeWarningsMissed,
    }).from(tradeMemoryTable)
      .where(and(
        eq(tradeMemoryTable.action, "TRADE_CLOSE"),
        isNotNull(tradeMemoryTable.candlePatternLesson),
        gte(tradeMemoryTable.createdAt, new Date('2026-06-04T00:00:00Z')),
      ))
      .orderBy(desc(tradeMemoryTable.createdAt))
      .limit(10)
      .catch(() => [] as Array<Record<string, unknown>>);

    if (patternRows.length > 0) {
      lines.push(`\n═══ CANDLE PATTERN LESSONS ═══`);
      for (const r of patternRows) {
        if (r.candlePatternLesson)
          lines.push(`${r.symbol}: ${r.candlePatternLesson}`);
      }
      // Extract common pre-entry warnings
      const warnCounts: Record<string, number> = {};
      for (const r of patternRows) {
        for (const w of (r.preTradeWarningsMissed as string[] | null) ?? []) {
          warnCounts[w] = (warnCounts[w] ?? 0) + 1;
        }
      }
      const topWarnings = Object.entries(warnCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([w, n]) => `- ${w} (${n}x)`).join("\n");
      if (topWarnings) {
        lines.push(`\nCommon pre-entry warnings to watch:`);
        lines.push(topWarnings);
      }
    }
  } catch { /* non-fatal */ }

  // ── Active trading rules ──
  try {
    const rules = await getActiveRules();
    if (rules.length) {
      lines.push(`\n═══ ACTIVE TRADING RULES ═══`);
      lines.push(`(Generated from trade reflections — these are SOFT rules, you may override with stated reason)`);
      for (const rule of rules) {
        const winRate = (rule.winsFollowing + rule.lossesFollowing) > 0
          ? Math.round(rule.winsFollowing / (rule.winsFollowing + rule.lossesFollowing) * 100) : null;
        const track = winRate !== null
          ? `Track record: ${rule.winsFollowing}W/${rule.lossesFollowing}L (${winRate}%)`
          : "Track record: no data yet";
        lines.push(`Rule ${rule.ruleNumber} [${rule.confidence}]: ${rule.ruleText}`);
        if (rule.evidence) lines.push(`  Evidence: ${rule.evidence}`);
        if (rule.causalLogic) lines.push(`  Logic: ${rule.causalLogic}`);
        lines.push(`  ${track}`);
      }
    }
  } catch { /* non-fatal */ }

  // ── Direction win rate stats (last 14 days) ──
  try {
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const recentClosed = await db.select({
      direction: tradeLogTable.direction,
      pnl:       tradeLogTable.pnl,
      pnlPct:    tradeLogTable.pnlPct,
    }).from(tradeLogTable)
      .where(and(isNotNull(tradeLogTable.exitAt), gte(tradeLogTable.exitAt, cutoff)));

    if (recentClosed.length > 0) {
      const statsByDir: Record<string, { total: number; wins: number; sumPnlPct: number }> = {};
      for (const t of recentClosed) {
        const dir = t.direction;
        if (!statsByDir[dir]) statsByDir[dir] = { total: 0, wins: 0, sumPnlPct: 0 };
        statsByDir[dir].total++;
        if (parseFloat(t.pnl ?? "0") > 0) statsByDir[dir].wins++;
        statsByDir[dir].sumPnlPct += parseFloat(t.pnlPct ?? "0");
      }

      let currentRegime = "UNKNOWN";
      try {
        const [st] = await db.select({ currentRegime: botStateTable.currentRegime }).from(botStateTable).limit(1);
        currentRegime = st?.currentRegime ?? "UNKNOWN";
      } catch { /* non-fatal */ }

      lines.push(`\n═══ PERFORMANCE BY DIRECTION (last 14 days) ═══`);
      for (const dir of ["long", "short"]) {
        const s = statsByDir[dir];
        if (!s) {
          lines.push(`${dir.toUpperCase()} trades: no data`);
        } else {
          const wr    = Math.round(s.wins / s.total * 100);
          const avgPct = (s.sumPnlPct / s.total).toFixed(2);
          const sign  = parseFloat(avgPct) >= 0 ? "+" : "";
          lines.push(`${dir.toUpperCase()} trades: ${s.total} total, ${wr}% win rate, avg ${sign}${avgPct}%`);
        }
      }
      lines.push(`Current regime: ${currentRegime}`);
      lines.push(`Apply this data to current decisions.`);
    }
  } catch { /* non-fatal */ }

  return lines.join("\n");
}

// ─── Startup backfill ─────────────────────────────────────────────────────────

export async function backfillStructuredReflections(max = 20): Promise<void> {
  // Exclude voided phantoms — trades that placed an entry order but never filled on exchange.
  // NULL-safe: or(isNull, ne) matches rows with no reflection text as well as real reflections.
  const closedTrades = await db.select()
    .from(tradeLogTable)
    .where(and(
      isNotNull(tradeLogTable.exitAt),
      or(isNull(tradeLogTable.reflection), ne(tradeLogTable.reflection, 'voided_phantom')),
    ))
    .orderBy(asc(tradeLogTable.entryAt))
    .catch(() => [] as Array<typeof tradeLogTable.$inferSelect>);

  let processed = 0;
  for (const trade of closedTrades) {
    if (processed >= max) break;

    // Deduplicate: skip only COMPLETE reflections (have lessonsLearned AND new verdict fields)
    const existingById = await db.select({ id: tradeMemoryTable.id })
      .from(tradeMemoryTable)
      .where(and(
        eq(tradeMemoryTable.sourceTradeId, trade.id),
        eq(tradeMemoryTable.action, "TRADE_CLOSE"),
        isNotNull(tradeMemoryTable.lessonsLearned),
        isNotNull(tradeMemoryTable.entryTimingVerdict), // batch-5 verdict fields present
      ))
      .limit(1)
      .catch(() => [] as Array<{ id: string }>);

    if (existingById.length > 0) continue;

    // Fall back to pnlPct match for old records without sourceTradeId that are complete
    const pnlPctStr = parseFloat(trade.pnlPct ?? "0").toFixed(4);
    const existingByPnl = await db.select({ id: tradeMemoryTable.id, sourceTradeId: tradeMemoryTable.sourceTradeId })
      .from(tradeMemoryTable)
      .where(and(
        eq(tradeMemoryTable.symbol, trade.symbol),
        eq(tradeMemoryTable.action, "TRADE_CLOSE"),
        isNotNull(tradeMemoryTable.lessonsLearned),
        isNotNull(tradeMemoryTable.entryTimingVerdict), // batch-5 verdict fields present
        isNull(tradeMemoryTable.sourceTradeId),
        eq(tradeMemoryTable.pnlPct, pnlPctStr),
      ))
      .limit(1)
      .catch(() => [] as Array<{ id: string; sourceTradeId: string | null }>);

    if (existingByPnl.length > 0) {
      await db.update(tradeMemoryTable)
        .set({ sourceTradeId: trade.id })
        .where(eq(tradeMemoryTable.id, existingByPnl[0]!.id))
        .catch(() => {});
      continue;
    }

    // Delete any incomplete reflection for this trade — three possible shapes:
    // (a) linked by sourceTradeId
    await db.delete(tradeMemoryTable)
      .where(and(
        eq(tradeMemoryTable.sourceTradeId, trade.id),
        eq(tradeMemoryTable.action, "TRADE_CLOSE"),
        isNull(tradeMemoryTable.lessonsLearned),
      ))
      .catch(() => {});
    // (b) old records without sourceTradeId, matched by symbol+pnlPct, missing lessons
    await db.delete(tradeMemoryTable)
      .where(and(
        eq(tradeMemoryTable.symbol, trade.symbol),
        eq(tradeMemoryTable.action, "TRADE_CLOSE"),
        isNull(tradeMemoryTable.sourceTradeId),
        isNull(tradeMemoryTable.lessonsLearned),
        eq(tradeMemoryTable.pnlPct, pnlPctStr),
      ))
      .catch(() => {});
    // (c) old-format records missing entryTiming entirely
    await db.delete(tradeMemoryTable)
      .where(and(
        eq(tradeMemoryTable.symbol, trade.symbol),
        eq(tradeMemoryTable.action, "TRADE_CLOSE"),
        isNull(tradeMemoryTable.entryTiming),
        eq(tradeMemoryTable.pnlPct, pnlPctStr),
      ))
      .catch(() => {});
    // (d) complete records missing batch-5 verdict fields — regenerate to add them
    await db.delete(tradeMemoryTable)
      .where(and(
        eq(tradeMemoryTable.sourceTradeId, trade.id),
        eq(tradeMemoryTable.action, "TRADE_CLOSE"),
        isNotNull(tradeMemoryTable.lessonsLearned),
        isNull(tradeMemoryTable.entryTimingVerdict),
      ))
      .catch(() => {});

    const entryPrice = parseFloat(trade.entryPrice ?? "0");
    const exitPrice  = parseFloat(trade.exitPrice  ?? "0");
    const pnl        = parseFloat(trade.pnl  ?? "0");
    const pnlPct     = parseFloat(trade.pnlPct ?? "0");

    if (!entryPrice || !exitPrice) {
      console.log(`[backfill] ${trade.symbol} — skipping (missing prices)`);
      continue;
    }

    console.log(`[backfill] Generating reflection for ${trade.symbol} ${trade.direction} ${pnlPct >= 0 ? "WIN" : "LOSS"} ${pnlPct.toFixed(2)}%`);

    await generateReflection({
      symbol:         trade.symbol,
      direction:      trade.direction,
      entryPrice,
      exitPrice,
      pnl,
      pnlPct,
      reasoning:      trade.reasoning ?? undefined,
      entryAt:        trade.entryAt,
      exitAt:         trade.exitAt,
      setupType:      trade.setupType,
      score:          trade.score,
      whyNow:         trade.whyNow,
      sl:             trade.sl,
      effectiveSl:    trade.effectiveSl ?? undefined,
      tp1:            trade.tp1,
      tp2:            trade.tp2,
      sourceTradeId:  trade.id,
      suppressAlerts: true,
    }).catch(e => console.error(`[backfill] ${trade.symbol} reflection failed:`, (e as Error).message));

    processed++;
    await sleep(1500); // rate limit Claude API
  }

  console.log(`[backfill] Done — ${processed} reflections generated`);
}

// ─── Utility queries ──────────────────────────────────────────────────────────

export async function getRecentTrades(limit = 10): Promise<typeof tradeLogTable.$inferSelect[]> {
  return db.select()
    .from(tradeLogTable)
    .where(isNotNull(tradeLogTable.exitAt))
    .orderBy(desc(tradeLogTable.exitAt))
    .limit(limit);
}

export async function getPerformanceSummary(): Promise<string> {
  try {
    const rows = await db.select({
      setupType: tradeLogTable.setupType,
      pnlPct:    tradeLogTable.pnlPct,
    })
    .from(tradeLogTable)
    .where(isNotNull(tradeLogTable.exitAt))
    .orderBy(desc(tradeLogTable.exitAt))
    .limit(200);

    if (!rows.length) return "";

    const bySetup: Record<string, { wins: number; total: number }> = {};
    for (const r of rows) {
      const setup = r.setupType ?? "UNKNOWN";
      if (!bySetup[setup]) bySetup[setup] = { wins: 0, total: 0 };
      bySetup[setup]!.total++;
      if (parseFloat(r.pnlPct ?? "0") > 0) bySetup[setup]!.wins++;
    }

    const lines = ["Your trading performance so far:"];
    lines.push("\nBy setup type:");
    for (const [setup, stats] of Object.entries(bySetup)) {
      const wr = stats.total > 0 ? Math.round(stats.wins / stats.total * 100) : 0;
      lines.push(`  ${setup}: ${stats.total} trades, ${wr}% win rate`);
    }
    lines.push("\nUse this to refine your entry decisions.");
    return lines.join("\n");
  } catch {
    return "";
  }
}

export async function getOpenTrades(): Promise<typeof tradeLogTable.$inferSelect[]> {
  return db.select()
    .from(tradeLogTable)
    .where(isNull(tradeLogTable.exitAt))
    .orderBy(desc(tradeLogTable.entryAt));
}

export async function getDailyPnl(): Promise<number> {
  // Use Bybit as source of truth — trade_log exitAt can be stamped at reconciliation time
  // rather than actual Bybit close time, causing false positives in the daily window.
  // Window starts at MAX(today 00:00 UTC, last /resume timestamp) so manual resumes
  // give a genuine fresh start without counting pre-resume losses.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  let since = todayStart.getTime();
  try {
    const [state] = await db.select({ resumeAt: botStateTable.resumeAt }).from(botStateTable).limit(1);
    if (state?.resumeAt) {
      since = Math.max(since, new Date(state.resumeAt).getTime());
    }
  } catch { /* non-fatal — fall back to today start */ }

  const closed = await bybitGetClosedPnl(50, since);
  return closed.reduce((sum, r) => sum + r.closedPnl, 0);
}

export async function logOpenTrade(params: {
  symbol: string; broker: string; direction: "long" | "short";
  entryPrice: number; leverage: number; amountUsd: number; reasoning?: string;
  stopLoss?: number; takeProfit?: number; stopLossMethod?: string;
}): Promise<string | null> {
  const enriched = [
    params.reasoning,
    params.stopLoss       ? `SL=$${params.stopLoss}`          : null,
    params.takeProfit     ? `TP=$${params.takeProfit}`         : null,
    params.stopLossMethod ? `method=${params.stopLossMethod}`  : null,
  ].filter(Boolean).join(" | ");

  try {
    const rows = await db.insert(tradeLogTable).values({
      symbol:     params.symbol,
      broker:     params.broker,
      direction:  params.direction,
      entryPrice: String(params.entryPrice),
      amountUsd:  String(params.amountUsd),
      leverage:   params.leverage,
      reasoning:  enriched || null,
      entryAt:    new Date(),
    }).returning({ id: tradeLogTable.id });
    return rows[0]?.id ?? null;
  } catch (e) {
    console.error("[tradeMemory] logOpenTrade failed:", e);
    return null;
  }
}

export async function closeOpenTrade(params: {
  symbol:              string;
  broker:              string;
  exitPrice:           number;
  amountUsd:           number;
  pnlOverride?:        number;
  entryPriceOverride?: number;
  directionOverride?:  "long" | "short";
  exitReason?:         string;   // explicit label — "sl_hit" | "tp_hit" | "review" | "profit_protection" | "hard_stop"
}): Promise<void> {
  const openTrades = await db.select()
    .from(tradeLogTable)
    .where(and(
      eq(tradeLogTable.symbol, params.symbol),
      eq(tradeLogTable.broker, params.broker),
      isNull(tradeLogTable.exitAt),
    ))
    .orderBy(desc(tradeLogTable.entryAt));

  if (!openTrades.length) {
    console.log(`[tradeMemory] No open trade found for ${params.symbol} on ${params.broker} — skipping reflection`);
    return;
  }

  const openTrade  = openTrades[0]!;
  const duplicates = openTrades.slice(1);

  const entryPrice = params.entryPriceOverride ?? parseFloat(openTrade.entryPrice ?? "0");
  const direction  = params.directionOverride ?? (openTrade.direction as "long" | "short");
  const qty        = params.amountUsd / (entryPrice || params.exitPrice || 1);

  const pnl    = params.pnlOverride !== undefined
    ? params.pnlOverride
    : direction === "long"
      ? (params.exitPrice - entryPrice) * qty
      : (entryPrice - params.exitPrice) * qty;
  const pnlPct = params.pnlOverride !== undefined
    ? (params.amountUsd > 0 ? (params.pnlOverride / params.amountUsd) * 100 : 0)
    : entryPrice > 0
      ? ((params.exitPrice - entryPrice) / entryPrice) * 100 * (direction === "long" ? 1 : -1)
      : 0;

  await db.update(tradeLogTable)
    .set({
      exitPrice:  params.exitPrice > 0 ? String(params.exitPrice) : openTrade.exitPrice,
      entryPrice: String(entryPrice),
      pnl:        String(pnl.toFixed(4)),
      pnlPct:     String(pnlPct.toFixed(4)),
      exitAt:     new Date(),
    })
    .where(eq(tradeLogTable.id, openTrade.id));

  for (const dup of duplicates) {
    await db.delete(tradeLogTable).where(eq(tradeLogTable.id, dup.id));
  }
  if (duplicates.length) {
    console.log(`[tradeMemory] Deleted ${duplicates.length} duplicate open entr${duplicates.length === 1 ? "y" : "ies"} for ${params.symbol}`);
  }

  await recordTradeOutcome(params.symbol, pnlPct).catch(() => {});

  generateReflection({
    symbol:    params.symbol,
    direction,
    entryPrice,
    exitPrice: params.exitPrice || entryPrice,
    pnl,
    pnlPct,
    reasoning: openTrade.reasoning ?? undefined,
    entryAt:   openTrade.entryAt,
    exitAt:    new Date(),
    setupType: openTrade.setupType,
    score:     openTrade.score,
    whyNow:    openTrade.whyNow,
    sl:        openTrade.sl,
    tp1:       openTrade.tp1,
    tp2:       openTrade.tp2,
    exitReasonOverride: params.exitReason,
  }).catch(e => console.error("[tradeMemory] reflection failed:", e));

  // Rule tracking — update only rules tagged at entry (appliedRuleIds)
  updateRuleStatsForTrade(pnlPct > 0, openTrade.id).catch(() => {});
  updatePendingOverrides(params.symbol, pnlPct).catch(() => {});
  checkAndGenerateRules().catch(() => {});
}
