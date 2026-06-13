import cron, { type ScheduledTask }   from "node-cron";
import { escapeHtml }                 from "./htmlUtils";
import { runScan, runFocusedScan, type ScanResult, type ScanOpportunity, calcATR, getRegimeThreshold } from "./marketScanner";
import { runPaperScan, runMode3PaperScan, updatePaperTradesPnl, startWeeklyAbReportCron, startPaperMonitorCron } from "./paperScanner";
import { cache, CacheKey }             from "./contextCache";
import { approvalGate, buildProposal } from "./approvalGate";
import { applyAtrSlTp, pendingLimitFills, removePendingLimitFill } from "./startup";
import { syncTotalCapitalToDB }        from "./brokerBalance";
import { isCoinSuspended, updateDailyPnl } from "./leverageManager";
import { getDailyPnl, logOpenTrade, closeOpenTrade, getOpenTrades, logPartialClose, getActiveRules, resolveExitReason } from "./tradeMemoryLib";
import { llm }                         from "./llmRouter";
import {
  getPositions    as bybitGetPositions,
  closePosition   as bybitClose,
  cancelOrder     as bybitCancelOrder,
  getOrders       as bybitGetOrders,
  setTp1Partial   as bybitSetTp1Partial,
  setTp2Partial   as bybitSetTp2Partial,
  closePercentPosition,
  setStopLoss     as bybitSetStopLoss,
  setTrailingStop,
  getFundingRate,
  getKlines,
  getOpenInterest,
  getClosedPnl    as bybitGetClosedPnl,
  type BybitPosition,
  type BybitKline,
} from "../brokers/bybit";
import { db, profileTable, botStateTable, tradeMemoryTable, tradeLogTable, tradingRulesTable, ruleOverridesTable, type PositionMeta, type PositionMonitorState, type WatchCoin } from "@workspace/db";
import { eq, and, desc, isNull, gt } from "drizzle-orm";

// ── Close helpers ─────────────────────────────────────────────────────────────

// Fetch the actual fill price from Bybit after a market close order.
// Waits 2s for the fill to settle, then reads closed-pnl. Falls back to the
// pre-order estimate if Bybit data is unavailable or mismatched.
async function fetchActualFillPrice(symbol: string, entryPrice: number, fallback: number): Promise<number> {
  await new Promise(r => setTimeout(r, 2000));
  try {
    const closes = await bybitGetClosedPnl(5, undefined, symbol);
    const fill = closes.find(c => Math.abs(c.avgEntryPrice / entryPrice - 1) < 0.05);
    if (fill && fill.avgExitPrice > 0) return fill.avgExitPrice;
  } catch { /* non-fatal */ }
  return fallback;
}

// ── Technical helpers ─────────────────────────────────────────────────────────
function calcEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = (closes[i]! * k) + (ema * (1 - k));
  return ema;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / avgLoss);
}

// ── Runtime state ─────────────────────────────────────────────────────────────
export let cronEnabled   = true;
export let tradingPaused = false;
export let pausedReason  = "";
export let lastScanTime: Date | null = null;

let cronTask:        ScheduledTask | null = null;
let watchScanTask:   ScheduledTask | null = null;
let watchScanNextAt: Date         | null = null;
let isScanning:      boolean              = false;
let currentInterval: string               = SCAN_INTERVAL ?? "0 */4 * * *";

type ScanNotifier   = (result: ScanResult, triggered: "cron" | "manual") => Promise<void>;
type AlertNotifier  = (message: string) => Promise<void>;
type ReviewNotifier = (symbol: string, decision: string, reason: string, pnlPctStr: string, reviewId: string) => Promise<void>;

let notifyFn:  ScanNotifier   | null = null;
let alertFn:   AlertNotifier  | null = null;
let reviewFn:  ReviewNotifier | null = null;

export function registerScanNotifier(fn: ScanNotifier): void    { notifyFn  = fn; }
export function registerAlertNotifier(fn: AlertNotifier): void  { alertFn   = fn; }
export function registerReviewNotifier(fn: ReviewNotifier): void { reviewFn = fn; }

// ── Pending manual-trade review gate ─────────────────────────────────────────
interface PendingReview {
  resolve: (approved: boolean) => void;
  timer:   ReturnType<typeof setTimeout>;
}
const pendingReviews = new Map<string, PendingReview>();

export function resolveReview(reviewId: string, approved: boolean): boolean {
  const r = pendingReviews.get(reviewId);
  if (!r) return false; // already timed out or never existed
  clearTimeout(r.timer);
  pendingReviews.delete(reviewId);
  r.resolve(approved);
  return true;
}

const SCAN_INTERVAL     = process.env["SCAN_INTERVAL"] ?? "*/30 * * * *";
let LARGE_PROFIT_CLOSE_PCT   = parseFloat(process.env["LARGE_PROFIT_CLOSE_PCT"]   ?? "20");
let LARGE_PROFIT_PARTIAL_PCT = parseFloat(process.env["LARGE_PROFIT_PARTIAL_PCT"] ?? "15");
export function setProfitThresholds(partial: number, full: number): void {
  LARGE_PROFIT_PARTIAL_PCT = partial;
  LARGE_PROFIT_CLOSE_PCT   = full;
}
export function getProfitThresholds(): { partial: number; full: number } {
  return { partial: LARGE_PROFIT_PARTIAL_PCT, full: LARGE_PROFIT_CLOSE_PCT };
}
const MAX_AUTO_TRADES   = parseInt(process.env["MAX_TRADES_PER_SCAN"] ?? "3");
const DAILY_LOSS_PCT    = 0.15;   // halt at -15% daily loss
const DRAWDOWN_PCT      = 0.35;   // halt at -35% from peak equity
const EQUITY_CLASSES    = new Set(["Equity", "US Equity", "equity", "Stock", "stock", "ETF", "etf"]);
const STARTING_BALANCE  = 50;     // initial deposit for profit protection calc

function humanInterval(crontab: string): string {
  if (!crontab) return "unknown";
  if (crontab === "disabled")      return "disabled (manual only)";
  if (crontab === "*/30 * * * *")  return "every 30 minutes";
  if (crontab === "*/15 * * * *")  return "every 15 minutes";
  if (crontab === "0 * * * *")     return "every hour";
  if (crontab === "0 */1 * * *")   return "every hour";
  if (crontab === "0 */2 * * *")   return "every 2 hours";
  if (crontab === "0 */4 * * *")   return "every 4 hours";
  if (crontab === "0 */6 * * *")   return "every 6 hours";
  return crontab;
}

const CRON_SHORTHANDS: Record<string, string> = {
  "1h": "0 * * * *",
  "2h": "0 */2 * * *",
  "4h": "0 */4 * * *",
  "6h": "0 */6 * * *",
};

type ScalingAction = "NEW" | "ADD" | "HOLD" | "CUT" | "TIER1" | "TIER2";

interface SignalOutcome {
  symbol:   string;
  action:   ScalingAction;
  amount?:  number;
  reason?:  string;
  pnlPct?:  number;
}

// ── bot_state in-memory cache ─────────────────────────────────────────────────
// Eliminates repeated DB reads. Write-through on all mutations.
let _botStateCache: Awaited<ReturnType<typeof _loadBotStateFromDb>> | null = null;

async function _loadBotStateFromDb() {
  const [row] = await db.select().from(botStateTable).limit(1);
  if (row) return row;
  await db.insert(botStateTable).values({ id: 1 }).onConflictDoNothing();
  const [fresh] = await db.select().from(botStateTable).limit(1);
  return fresh!;
}

async function loadBotState() {
  if (_botStateCache) return _botStateCache;
  _botStateCache = await _loadBotStateFromDb();
  return _botStateCache;
}

async function saveBotState(patch: Partial<typeof botStateTable.$inferInsert>): Promise<void> {
  if (_botStateCache) _botStateCache = { ..._botStateCache, ...patch } as typeof _botStateCache;
  await db.update(botStateTable).set({ ...patch, lastUpdated: new Date() }).where(eq(botStateTable.id, 1));
}

export function invalidateBotStateCache(): void {
  _botStateCache = null;
}

// ── Layer 5: Peak drawdown + daily loss halt ──────────────────────────────────
async function checkDailyLossLimit(bybitBalance: number): Promise<boolean> {
  try {
    const state = await loadBotState();

    // Update peak equity
    const peak = Math.max(state.peakEquity ?? bybitBalance, bybitBalance);
    if ((state.peakEquity ?? 0) < peak) {
      await saveBotState({ peakEquity: peak }).catch(() => {});
    }

    // Peak drawdown halt (-35%)
    if (bybitBalance < peak * (1 - DRAWDOWN_PCT)) {
      const drawPct = (((peak - bybitBalance) / peak) * 100).toFixed(1);
      const msg = [
        `🛑 Peak drawdown -${drawPct}% hit — trading halted`,
        `Peak: $${peak.toFixed(2)} → Current: $${bybitBalance.toFixed(2)}`,
        `Manual /resume required`,
      ].join("\n");
      tradingPaused = true;
      pausedReason  = msg;
      await saveBotState({ tradingPaused: true, pausedReason: msg }).catch(() => {});
      await alertFn?.(msg).catch(e => console.error("[telegram] Send failed:", (e as Error).message));
      console.warn("[cronScanner] Peak drawdown halt triggered");
      return false;
    }

    // Daily loss halt (-15%)
    const dailyPnl = await getDailyPnl();
    await updateDailyPnl(dailyPnl).catch(() => {});

    if (dailyPnl <= -(bybitBalance * DAILY_LOSS_PCT)) {
      const pct = ((Math.abs(dailyPnl) / bybitBalance) * 100).toFixed(1);
      const msg = [
        `🛑 Daily loss limit -${pct}% hit — trading paused`,
        `Loss today: $${Math.abs(dailyPnl).toFixed(2)} of $${bybitBalance.toFixed(2)}`,
        `Resume tomorrow or type /resume to override`,
      ].join("\n");
      tradingPaused = true;
      pausedReason  = msg;
      await saveBotState({ tradingPaused: true, pausedReason: msg }).catch(() => {});
      await alertFn?.(msg).catch(e => console.error("[telegram] Send failed:", (e as Error).message));
      console.warn("[cronScanner] Daily loss limit hit — trading paused");
      return false;
    }

    return true;
  } catch { return true; }
}

// ── Layer 4: R-multiple position sizing ──────────────────────────────────────
// Returns MARGIN amount (not notional). Executor multiplies by leverage to get notional.
function calcRMultipleSizing(
  balance:      number,
  entry:        number,
  stopLoss:     number,
  leverage:     number,
  score:        number,
  conflictRes:  string,
  timing:       string,
  setupQuality: string,
): number {
  const minimumMargin = 5;                  // Bybit minimum
  const maximumMargin = balance * 0.30;     // never commit more than 30% of balance as margin

  if (entry <= 0 || stopLoss <= 0) {
    return Math.max(minimumMargin, Math.min(balance * 0.05, maximumMargin));
  }

  let rMult =
    score >= 90 ? 1.2 :
    score >= 75 ? 1.0 :
    score >= 65 ? 0.5 : 0;

  if (rMult === 0) return 0;
  if (conflictRes === "MINOR_REDUCED") rMult *= 0.5;
  if (timing       === "LATE")         rMult *= 0.5;
  if (setupQuality === "LOW")          rMult *= 0.5;

  const stopLossPct = Math.abs(entry - stopLoss) / entry;
  if (stopLossPct <= 0) {
    return Math.max(minimumMargin, Math.min(balance * 0.05, maximumMargin));
  }

  // Margin needed so that a SL hit loses exactly riskAmount:
  //   loss = margin × stopLossPct × leverage  →  margin = riskAmount / (stopLossPct × leverage)
  const riskAmount = balance * 0.05 * rMult;
  const marginSize = riskAmount / (stopLossPct * leverage);

  console.log("Position sizing:", {
    riskAmount,
    minimumMargin,
    maximumMargin,
    finalMargin: Math.max(minimumMargin, Math.min(marginSize, maximumMargin)),
  });

  return Math.max(minimumMargin, Math.min(marginSize, maximumMargin));
}

// ── Layer 2: Hard filters ─────────────────────────────────────────────────────
interface FilterResult {
  passed:   ScanOpportunity[];
  rejected: Array<{ symbol: string; reason: string }>;
}

async function applyHardFilters(
  opps:    ScanOpportunity[],
  regime:  ScanResult["regime"],
): Promise<FilterResult> {
  const passed:   ScanOpportunity[]                      = [];
  const rejected: Array<{ symbol: string; reason: string }> = [];

  for (const opp of opps) {
    // Filter 1 (hard): Block LONG entries in confirmed downtrend regimes.
    // TRENDING_DOWN = ADX>25 DI- dominant; STRONG_TREND bearish = ADX>35 DI- dominant.
    // NOT overridable by Claude — structurally equivalent downtrends, only ADX magnitude differs.
    if (opp.direction === "long") {
      const r           = regime?.regime;
      const bearishStrong = r === "STRONG_TREND" && (regime?.diMinus ?? 0) > (regime?.diPlus ?? 0);
      if (r === "TRENDING_DOWN" || bearishStrong) {
        const detail = `${r} DI- ${regime?.diMinus?.toFixed(1)} > DI+ ${regime?.diPlus?.toFixed(1)}`;
        rejected.push({ symbol: opp.symbol, reason: `downtrend gate: LONG blocked (${detail})` });
        continue;
      }
    }

    // Filter 5: Low liquidity (volume24h < $10M)
    if (opp.volume24h && opp.volume24h < 10_000_000) {
      rejected.push({ symbol: opp.symbol, reason: `low liquidity $${(opp.volume24h / 1e6).toFixed(1)}M < $10M` });
      continue;
    }

    // Fetch 4h klines for filters 2-4
    let klines4h: Awaited<ReturnType<typeof getKlines>> = [];
    try { klines4h = await getKlines(opp.symbol, "240", 60); } catch { /* skip kline filters */ }

    if (klines4h.length >= 50) {
      const closes = klines4h.map(k => k.close);
      const highs  = klines4h.map(k => k.high);
      const lows   = klines4h.map(k => k.low);
      const price  = closes[closes.length - 1] ?? opp.price;

      const high50      = Math.max(...highs.slice(-50));
      const low50       = Math.min(...lows.slice(-50));
      const pctFromHigh = Math.abs(price - high50) / high50 * 100;
      const pctFromLow  = Math.abs(price - low50)  / low50  * 100;

      if (regime?.regime === "RANGING") {
        // In RANGING: only allow entries at range boundaries (within 3%)
        // Bot advantage: catch exact turns at support/resistance
        const BOUNDARY = 3.0;
        if (opp.direction === "short" && pctFromHigh > BOUNDARY) {
          rejected.push({ symbol: opp.symbol, reason: `RANGING: price ${pctFromHigh.toFixed(1)}% from resistance $${high50.toFixed(4)} — wait for boundary` });
          continue;
        }
        if (opp.direction === "long" && pctFromLow > BOUNDARY) {
          rejected.push({ symbol: opp.symbol, reason: `RANGING: price ${pctFromLow.toFixed(1)}% from support $${low50.toFixed(4)} — wait for boundary` });
          continue;
        }
        // At the correct boundary — skip directional EMA filters (price oscillates in ranges)
      } else {
        // Filter 3: Trending regime — reject entries at wrong boundary
        if (opp.direction === "long" && pctFromHigh < 0.5) {
          rejected.push({ symbol: opp.symbol, reason: `near 50-period high (HTF resistance) — long rejected` });
          continue;
        }
        if (opp.direction === "short" && pctFromLow < 0.5) {
          rejected.push({ symbol: opp.symbol, reason: `near 50-period low (HTF support) — short rejected` });
          continue;
        }

        // Filter 4: EMA trend alignment (skip in RANGING — price oscillates through EMAs)
        const ema20_4h = calcEMA(closes, 20);
        const ema50_4h = calcEMA(closes, 50);
        if (opp.direction === "long" && price < ema50_4h * 0.97) {
          rejected.push({ symbol: opp.symbol, reason: `price > 3% below 4h EMA50 — weak momentum for long` });
          continue;
        }
        if (opp.direction === "short" && price > ema20_4h * 1.03) {
          rejected.push({ symbol: opp.symbol, reason: `price > 3% above 4h EMA20 — strong uptrend, short rejected` });
          continue;
        }
      }
    }

    // Filter 2: Extreme funding rate (|rate| > 0.1% per 8h)
    try {
      const fr = await getFundingRate(opp.symbol);
      if (Math.abs(fr.rate * 100) > 0.1) {
        rejected.push({ symbol: opp.symbol, reason: `extreme funding ${(fr.rate * 100).toFixed(4)}% > 0.1%` });
        continue;
      }
    } catch { /* allow if unavailable */ }

    passed.push(opp);
  }

  return { passed, rejected };
}

// ── Layer 5: Stale order cancellation ────────────────────────────────────────
async function cancelStaleOrders(): Promise<{
  cancelled: Array<{ symbol: string; price: number }>;
  active:    Array<{ symbol: string; side: string; price: number; qty: number; placedAt: string }>;
}> {
  const cancelled: Array<{ symbol: string; price: number }> = [];
  const active:    Array<{ symbol: string; side: string; price: number; qty: number; placedAt: string }> = [];
  let orders: Awaited<ReturnType<typeof bybitGetOrders>> = [];
  let fetchErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      orders = await bybitGetOrders();
      fetchErr = null;
      break;
    } catch (e) {
      fetchErr = e as Error;
      console.error(`[cronScanner] getOrders attempt ${attempt}/3 failed:`, fetchErr.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (fetchErr) {
    await alertFn?.("⚠️ Order fetch failed — stale order cancellation may have been skipped").catch(e => console.error("[telegram] Send failed:", (e as Error).message));
    return { cancelled, active };
  }
  try {
    const fourHAgo = Date.now() - 4 * 60 * 60 * 1000;
    for (const order of orders) {
      const placedAt = new Date(order.placedAt).getTime();
      if (placedAt < fourHAgo) {
        await bybitCancelOrder(order.symbol, order.orderId).catch(e =>
          console.warn(`[cronScanner] Cancel order ${order.orderId} failed:`, e.message)
        );
        // Void the trade_log entry — no position was ever opened, no reflection needed
        await db.update(tradeLogTable)
          .set({ exitAt: new Date(), pnl: "0", pnlPct: "0" })
          .where(and(eq(tradeLogTable.symbol, order.symbol), isNull(tradeLogTable.exitAt)))
          .catch(() => {});
        await removePendingLimitFill(order.symbol).catch(() => {});
        await clearPositionMeta(order.symbol).catch(() => {});
        await alertFn?.(`🚫 Limit order ${order.symbol} $${order.price} cancelled — unfilled after 4h, re-evaluating`).catch(e => console.error("[telegram] Send failed:", (e as Error).message));
        console.log(`[cronScanner] Cancelled stale 4h order ${order.orderId} ${order.symbol}`);
        cancelled.push({ symbol: order.symbol, price: order.price });
      } else {
        active.push({ symbol: order.symbol, side: order.side, price: order.price, qty: order.qty, placedAt: order.placedAt });
      }
    }
  } catch (e) {
    console.error("[cronScanner] staleOrderCheck failed:", (e as Error).message);
  }
  return { cancelled, active };
}

// ── Layer 5: 48h hold timer → Claude review ──────────────────────────────────
async function checkHoldTimers(
  livePositions: BybitPosition[],
  regime:        ScanResult["regime"],
): Promise<void> {
  const REVIEW_MS   = 48 * 60 * 60 * 1000;
  const EXTEND_MS   = 24 * 60 * 60 * 1000;
  const now         = Date.now();

  const state      = await loadBotState().catch(() => null);
  const allMeta    = (state?.positionMetadata ?? {}) as Record<string, PositionMeta>;
  const openTrades = await getOpenTrades().catch(() => [] as Awaited<ReturnType<typeof getOpenTrades>>);

  for (const pos of livePositions) {
    const pm       = allMeta[pos.symbol];
    const openedAt = pm?.openedAt ?? pos.openTime ?? 0;
    if (!openedAt || openedAt <= 0) continue;

    const holdMs = now - openedAt;
    if (holdMs < REVIEW_MS) continue;

    const holdH       = Math.round(holdMs / 3600000);
    const direction   = pos.side === "Buy" ? "long" : "short";
    const currentPrice = pos.entryPrice + (pos.pnl / Math.max(pos.size, 0.0001));
    const pnlSign     = pos.pnl >= 0 ? "+" : "";

    console.log(`[cronScanner] 48h review: ${pos.symbol} ${direction} open ${holdH}h — asking Claude`);

    // Fetch 4h klines + funding rate in parallel
    const [klRes, frRes] = await Promise.allSettled([
      getKlines(pos.symbol, "240", 50),
      getFundingRate(pos.symbol),
    ]);

    let rsi4h    = 50;
    let emaLine  = "unavailable";
    if (klRes.status === "fulfilled") {
      const closes = klRes.value.map(k => k.close);
      rsi4h        = calcRSI(closes, 14);
      const ema20  = calcEMA(closes, 20);
      const ema50  = calcEMA(closes, 50);
      const rel    = currentPrice > ema20 ? "above" : "below";
      emaLine      = `price ${rel} EMA20=$${ema20.toFixed(4)}, EMA50=$${ema50.toFixed(4)}`;
    }

    const frRate = frRes.status === "fulfilled" ? frRes.value.rate : 0;
    const frSign = frRate >= 0 ? "+" : "";
    const frLine = `${frSign}${(frRate * 100).toFixed(4)}%`;

    const slLine  = pm?.sl   ? `$${pm.sl.toFixed(4)}`  : (pos.stopLoss   ? `$${pos.stopLoss}`   : "none");
    const tp1Line = pm?.tp1  ? `$${pm.tp1.toFixed(4)}` : (pos.takeProfit ? `$${pos.takeProfit}` : "none");

    const openTrade = openTrades.find(t => t.symbol === pos.symbol && t.broker === "bybit");
    const thesis    = openTrade?.reasoning ?? "No thesis recorded";

    const prompt = [
      `Position held ${holdH}h — time review:`,
      `Symbol: ${pos.symbol}`,
      `Direction: ${direction}`,
      `Entry: $${pos.entryPrice.toFixed(4)}`,
      `Current: $${currentPrice.toFixed(4)}`,
      `P/L: ${pnlSign}${pos.pnlPct.toFixed(2)}%`,
      `SL: ${slLine} (not hit)`,
      `TP1: ${tp1Line} (not hit)`,
      ``,
      `Current regime: ${regime?.regime ?? "UNKNOWN"} (ADX ${regime?.adx?.toFixed(0) ?? "?"})`,
      `4h RSI: ${rsi4h.toFixed(1)}`,
      `4h EMA trend: ${emaLine}`,
      `Funding rate: ${frLine}`,
      ``,
      `Trade thesis at entry: ${thesis}`,
      ``,
      `Decide: HOLD / CLOSE / EXTEND_24H`,
      `HOLD = thesis intact, resume monitoring with timer reset to 24h`,
      `CLOSE = thesis broken or risk not justified, exit now`,
      `EXTEND_24H = uncertain, revisit in 24h`,
      `Explain why in one sentence.`,
      `Return JSON: {"decision":"HOLD"|"CLOSE"|"EXTEND_24H","reason":"<one sentence>"}`,
    ].join("\n");

    const res = await llm.json<{ decision: string; reason: string }>({
      taskType:      "trade_decision",
      systemContext: "You are a disciplined trading risk manager reviewing a held futures position. Respond JSON only.",
      prompt,
      schema: {
        type: "object", required: ["decision", "reason"],
        properties: { decision: { type: "string" }, reason: { type: "string" } },
      },
      fallback: { decision: "CLOSE", reason: "LLM unavailable — defaulting to close" },
    }).catch(() => ({ data: { decision: "CLOSE", reason: "LLM error — defaulting to close" }, parseSuccess: false }));

    const raw      = res.data.decision?.toUpperCase() ?? "CLOSE";
    const decision = (["HOLD", "CLOSE", "EXTEND_24H"].includes(raw) ? raw : "CLOSE") as "HOLD" | "CLOSE" | "EXTEND_24H";
    const reason   = res.data.reason ?? "";

    console.log(`[cronScanner] 48h review ${pos.symbol}: ${decision} — ${reason}`);

    if (decision === "CLOSE") {
      try {
        await bybitClose(pos.symbol);
        const actualFill = await fetchActualFillPrice(pos.symbol, pos.entryPrice, currentPrice);
        await closeOpenTrade({
          symbol: pos.symbol, broker: "bybit",
          exitPrice: actualFill, amountUsd: pos.size * pos.entryPrice,
          entryPriceOverride: pos.entryPrice,
          directionOverride: pos.side === "Buy" ? "long" : "short",
          exitReason: "review",
        }).catch(() => {});
        await clearPositionMeta(pos.symbol).catch(() => {});
        await alertFn?.([
          `⏱️ 48h review — ${pos.symbol}`,
          `Decision: CLOSE`,
          `Reason: ${escapeHtml(reason)}`,
          `P/L: ${pnlSign}$${pos.pnl.toFixed(2)} (${pnlSign}${pos.pnlPct.toFixed(2)}%)`,
        ].join("\n")).catch(() => {});
      } catch (e) {
        console.error(`[cronScanner] 48h close ${pos.symbol}:`, (e as Error).message);
      }
    } else {
      // HOLD or EXTEND_24H — push openedAt forward so review fires again in 24h
      const newOpenedAt = now - (REVIEW_MS - EXTEND_MS); // holdMs will be 24h on next check
      if (pm) {
        const updatedMeta = { ...pm, openedAt: newOpenedAt };
        const patchedMeta = { ...allMeta, [pos.symbol]: updatedMeta };
        await saveBotState({ positionMetadata: patchedMeta }).catch(() => {});
      }
      await alertFn?.([
        `⏱️ 48h review — ${pos.symbol}`,
        `Decision: ${escapeHtml(decision)}`,
        `Reason: ${escapeHtml(reason)}`,
        `Next review: 24h`,
      ].join("\n")).catch(() => {});
    }
  }
}

// ── Layer 5: Partial exit monitoring (tier-based) ────────────────────────────
async function checkPartialExits(livePositions: BybitPosition[]): Promise<void> {
  if (partialExitRunning) { console.log("[partialExit] Previous check still running — skipping tick"); return; }
  partialExitRunning = true;
  try {
  await _checkPartialExits(livePositions);
  } finally {
    partialExitRunning = false;
  }
}

async function _checkPartialExits(livePositions: BybitPosition[]): Promise<void> {
  const state = await loadBotState().catch(() => null);
  if (!state) return;
  const meta = (state.positionMetadata ?? {}) as Record<string, PositionMeta>;

  for (const pos of livePositions) {
    const pm = meta[pos.symbol];
    if (!pm) continue; // no metadata — skip until next open stores it

    if (pm.entrySource && pm.entrySource !== "auto_scan") {
      console.log(`[partialExit] ${pos.symbol} is manual trade (${pm.entrySource}) — skipping auto partial close`);
      continue;
    }

    // Read TP1/TP2 from trade_log as durable fallback (survives restarts)
    const tradeRows = await db
      .select({ tp1: tradeLogTable.tp1, tp2: tradeLogTable.tp2 })
      .from(tradeLogTable)
      .where(and(eq(tradeLogTable.symbol, pos.symbol), isNull(tradeLogTable.exitAt)))
      .orderBy(desc(tradeLogTable.entryAt))
      .limit(1)
      .catch(() => [] as Array<{ tp1: string | null; tp2: string | null }>);
    const dbTp1 = tradeRows[0]?.tp1 ? parseFloat(tradeRows[0].tp1) : 0;
    const dbTp2 = tradeRows[0]?.tp2 ? parseFloat(tradeRows[0].tp2) : 0;
    const resolvedTp1 = (pm.tp1 && pm.tp1 > 0) ? pm.tp1 : dbTp1;
    const resolvedTp2 = (pm.tp2 && pm.tp2 > 0) ? pm.tp2 : dbTp2;

    // Use markPrice when available; fall back to PnL-derived estimate
    const markPx = (pos as any).markPrice as number | undefined;
    const currentPrice = (markPx && markPx > 0)
      ? markPx
      : pos.side === "Buy"
        ? pos.entryPrice + (pos.pnl / Math.max(pos.size, 0.00001))
        : pos.entryPrice - (pos.pnl / Math.max(pos.size, 0.00001));

    // Detect stale originalQty (off by >10× current size — stale from old session)
    let origQty = pm.originalQty;
    if (!origQty || origQty <= 0 || origQty > pos.size * 10 || origQty < pos.size * 0.1) {
      console.log(`[partialExit] ${pos.symbol} — stale originalQty (${origQty} vs current ${pos.size}) → resetting to current size`);
      origQty = pos.size;
      await patchPositionMeta(pos.symbol, { originalQty: pos.size }).catch(() => {});
    }

    const qtyRatio = pos.size / origQty;
    // Infer current tier from qty ratio
    const currentTier = qtyRatio > 0.85 ? 0 : qtyRatio > 0.55 ? 1 : qtyRatio > 0.25 ? 2 : 3;

    // TP1 plausibility: must be within 50% of current price, otherwise metadata is stale
    const tp1Valid = resolvedTp1 > 0 && Math.abs(resolvedTp1 / currentPrice - 1) < 0.50;
    const tp2Valid = resolvedTp2 > 0 && Math.abs(resolvedTp2 / currentPrice - 1) < 0.50;
    const effectiveTp1 = tp1Valid ? resolvedTp1 : 0;
    const effectiveTp2 = tp2Valid ? resolvedTp2 : 0;

    if (resolvedTp1 > 0 && !tp1Valid) {
      console.log(`[partialExit] ${pos.symbol} — TP1 $${resolvedTp1} implausible vs price $${currentPrice.toFixed(4)} → skipping TP1 check`);
    }

    console.log(`[partialExit] ${pos.symbol} ${pos.side} | current: $${currentPrice.toFixed(4)} | TP1: $${effectiveTp1 || "none"} | TP2: $${effectiveTp2 || "none"} | tier: ${currentTier} | triggered: tp1=${effectiveTp1 > 0 && (pos.side === "Buy" ? currentPrice >= effectiveTp1 : currentPrice <= effectiveTp1)} tp2=${effectiveTp2 > 0 && (pos.side === "Buy" ? currentPrice >= effectiveTp2 : currentPrice <= effectiveTp2)}`);

    // Skip if position already nearly closed (exchange TP may have already fired)
    if (pos.size < origQty * 0.05) {
      console.log(`[partialExit] ${pos.symbol} — position nearly closed (${pos.size}/${origQty}) → skipping`);
      continue;
    }

    // Detect silent exchange-side TP1 fill: position already reduced ≥15% but flag not set.
    // Exchange partial TP orders fire without triggering any code hook, so tp1Executed can stay
    // false even after Bybit reduces the position. Set the flag AND apply the same +1% SL ratchet
    // as the software TP1 path — guarded so it only fires if it improves (tightens) the current SL.
    if (effectiveTp1 > 0 && !pm.tp1Executed && pos.size < origQty * 0.85) {
      console.log(`[partialExit] ${pos.symbol} — exchange TP1 detected: size ${pos.size}/${origQty} (${(qtyRatio * 100).toFixed(0)}%) < 85% → marking tp1Executed, applying SL ratchet`);
      await patchPositionMeta(pos.symbol, { tp1Executed: true }).catch(() => {});
      pm.tp1Executed = true; // update local copy so TP2 gate below sees it this tick
      // Ratchet SL to +1% beyond entry — same as software TP1 path
      const tp1SlB = pos.side === "Buy" ? pm.entryPrice * 1.01 : pm.entryPrice * 0.99;
      const curSlRawB = pm.sl ?? pos.stopLoss ?? 0;
      const curSlB = typeof curSlRawB === "number" ? curSlRawB : parseFloat(String(curSlRawB) || "0");
      const wouldImproveB = pos.side === "Buy" ? tp1SlB > curSlB : (curSlB === 0 || tp1SlB < curSlB);
      if (wouldImproveB) {
        await bybitSetStopLoss(pos.symbol, tp1SlB, pos.positionIdx)
          .catch(e => console.warn(`[partialExit] exchange TP1 SL ratchet failed ${pos.symbol}:`, e.message));
        await patchPositionMeta(pos.symbol, { sl: tp1SlB }).catch(() => {});
        db.update(tradeLogTable).set({ effectiveSl: String(tp1SlB) })
          .where(and(eq(tradeLogTable.symbol, pos.symbol), isNull(tradeLogTable.exitAt))).catch(() => {});
        console.log(`[partialExit] ${pos.symbol} SL ratcheted → $${tp1SlB.toFixed(4)} (exchange-side TP1)`);
      }
    }

    // TP1: price reached TP1 and explicit flag not yet set
    // pm.tp1Executed is the sole authoritative gate; it is set explicitly when TP1 fires,
    // or above when exchange-side reduction is detected.
    if (effectiveTp1 > 0 && !pm.tp1Executed) {
      const tp1Reached = pos.side === "Buy" ? currentPrice >= effectiveTp1 : currentPrice <= effectiveTp1;
      if (tp1Reached) {
        console.log(`[cronScanner] TP1 exit: ${pos.symbol} price=$${currentPrice.toFixed(4)} tp1=$${effectiveTp1}`);
        try {
          // Set flag BEFORE close — prevents double-close if exchange partial order already executed
          await patchPositionMeta(pos.symbol, { tp1Executed: true }).catch(() => {});
          const tp1ClosePct   = Math.max(20, pm.tp1ClosePercent ?? 30);
          await closePercentPosition(pos.symbol, tp1ClosePct);
          // Move SL to +1% beyond entry (longs: entry×1.01, shorts: entry×0.99)
          const tp1Sl = pos.side === "Buy" ? pm.entryPrice * 1.01 : pm.entryPrice * 0.99;
          await bybitSetStopLoss(pos.symbol, tp1Sl, pos.positionIdx)
            .catch(e => console.warn(`[cronScanner] TP1 +1% SL failed ${pos.symbol}:`, e.message));
          await patchPositionMeta(pos.symbol, { sl: tp1Sl }).catch(() => {});
          db.update(tradeLogTable).set({ effectiveSl: String(tp1Sl) })
            .where(and(eq(tradeLogTable.symbol, pos.symbol), isNull(tradeLogTable.exitAt))).catch(() => {});
          const banked        = pos.pnl * (tp1ClosePct / 100);
          const base          = pos.symbol.replace(/USDT$/, "");
          const remainQty     = +(pos.size * (1 - tp1ClosePct / 100)).toFixed(4);
          const remainMargin  = pos.margin * (1 - tp1ClosePct / 100);
          const dustLine      = remainMargin < 1 ? `⚠️ Remaining margin < $1 — consider closing` : null;
          await alertFn?.([
            `💰 TP1 profit banked — ${pos.symbol}`,
            `Closed: ${tp1ClosePct}% at ~$${currentPrice.toFixed(4)}`,
            `P/L banked: +$${banked.toFixed(2)}`,
            `SL locked to +1%: $${tp1Sl.toFixed(4)}`,
            `Remaining: ${remainQty} ${base} ($${remainMargin.toFixed(2)} margin)`,
            dustLine,
          ].filter(Boolean).join("\n")).catch(() => {});
          const pnlPctTp1 = pm.entryPrice > 0 ? ((currentPrice - pm.entryPrice) / pm.entryPrice) * 100 * (pos.side === "Buy" ? 1 : -1) : 0;
          logPartialClose({ symbol: pos.symbol, partialType: "tp1", closePct: tp1ClosePct, priceAtClose: currentPrice, pnlPct: pnlPctTp1, remainingPct: 100 - tp1ClosePct }).catch(() => {});
        } catch (e) {
          console.error(`[cronScanner] TP1 exit ${pos.symbol} failed:`, (e as Error).message);
        }
        continue;
      }
    }

    // TP2: price reached TP2, TP1 already executed (flag or tier), and TP2 flag not yet set.
    // !pm.tp2Executed is the sole gate — currentTier < 2 removed: stale originalQty can pin tier=3
    // even after normal TP1 partial, permanently blocking TP2.
    if (effectiveTp2 > 0 && (pm.tp1Executed || currentTier >= 1) && !pm.tp2Executed) {
      const tp2Reached = pos.side === "Buy" ? currentPrice >= effectiveTp2 : currentPrice <= effectiveTp2;
      if (tp2Reached) {
        console.log(`[cronScanner] TP2 exit: ${pos.symbol} price=$${currentPrice.toFixed(4)} tp2=$${effectiveTp2}`);
        try {
          const tp2Pct    = pm.tp2ClosePercent ?? 100;
          await closePercentPosition(pos.symbol, tp2Pct);
          await patchPositionMeta(pos.symbol, { tp2Executed: true }).catch(() => {});
          const closedQty     = +(pos.size * (tp2Pct / 100)).toFixed(4);
          const banked        = pos.pnl * (tp2Pct / 100);
          const base2         = pos.symbol.replace(/USDT$/, "");
          const remainQty2    = +(pos.size - closedQty).toFixed(4);
          const remainMargin2 = remainQty2 * pos.entryPrice / Math.max(pos.leverage, 1);
          const trailLine     = tp2Pct < 100 ? `Remaining: ${remainQty2} ${base2} ($${remainMargin2.toFixed(2)} margin) with trailing SL` : null;
          const dustLine2     = remainMargin2 < 1 && tp2Pct < 100 ? `⚠️ Remaining margin < $1 — consider closing` : null;
          await alertFn?.([
            `💰 TP2 profit banked — ${pos.symbol}`,
            `Closed: ${tp2Pct}% at ~$${currentPrice.toFixed(4)}`,
            `P/L banked: +$${banked.toFixed(2)}`,
            trailLine,
            dustLine2,
          ].filter(Boolean).join("\n")).catch(() => {});
          const pnlPctTp2 = pm.entryPrice > 0 ? ((currentPrice - pm.entryPrice) / pm.entryPrice) * 100 * (pos.side === "Buy" ? 1 : -1) : 0;
          logPartialClose({ symbol: pos.symbol, partialType: "tp2", closePct: tp2Pct, priceAtClose: currentPrice, pnlPct: pnlPctTp2, remainingPct: 100 - tp2Pct }).catch(() => {});
        } catch (e) {
          console.error(`[cronScanner] TP2 exit ${pos.symbol} failed:`, (e as Error).message);
        }
      }
    }
  }
}

// ── Layer 5: Regime change flattener ─────────────────────────────────────────
async function checkRegimeFlattener(
  regime: ScanResult["regime"],
  livePositions: BybitPosition[],
): Promise<void> {
  if (!regime) return;
  const state = await loadBotState().catch(() => null);
  const prevRegime = state?.currentRegime ?? "";

  // Persist new regime
  if (prevRegime !== regime.regime) {
    await saveBotState({ currentRegime: regime.regime, regimeChangedAt: new Date() }).catch(() => {});
  }

  // Flatten 50% if regime shifted to CHOPPY or EXHAUSTION (not RANGING — that allows range trades)
  if (
    (regime.regime === "CHOPPY" || regime.regime === "EXHAUSTION") &&
    prevRegime !== regime.regime &&
    prevRegime !== "" &&
    livePositions.length > 0
  ) {
    console.log(`[cronScanner] Regime changed to ${regime.regime} — reducing exposure 50%`);
    await alertFn?.([
      `⚠️ Regime shifted to ${regime.regime}`,
      `Reducing exposure — closing 50% of all positions`,
      escapeHtml(regime.summary ?? ""),
    ].join("\n")).catch(() => {});

    for (const pos of livePositions) {
      await closePercentPosition(pos.symbol, 50).catch(e =>
        console.warn(`[cronScanner] Regime flatten ${pos.symbol}:`, e.message)
      );
    }
  }
}

// ── Trade memory batch buffer (flushed once per day) ─────────────────────────
type MemoryEntry = { symbol: string; reflection: string; whatWorked: string; whatDidnt: string | null };
const _memoryBuffer: MemoryEntry[] = [];
let   _memoryLastFlushed = Date.now();
const MEMORY_FLUSH_INTERVAL_MS = 24 * 3600_000;

async function flushMemoryBuffer(): Promise<void> {
  if (!_memoryBuffer.length) return;
  const batch = _memoryBuffer.splice(0);
  await db.insert(tradeMemoryTable).values(batch)
    .catch(e => console.error("[cronScanner] memory flush failed:", e));
  console.log(`[cronScanner] Flushed ${batch.length} memory entries to DB`);
  _memoryLastFlushed = Date.now();
}

async function logScalingDecision(
  symbol:    string,
  action:    ScalingAction,
  reasoning: string,
  pnlPct?:   number,
): Promise<void> {
  if (action === "HOLD") return; // HOLD decisions are not trade closes — no journal entry
  _memoryBuffer.push({
    symbol,
    reflection: reasoning,
    whatWorked: String(action),
    whatDidnt:  pnlPct != null ? `P/L at decision: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : null,
  });
  if (Date.now() - _memoryLastFlushed >= MEMORY_FLUSH_INTERVAL_MS) {
    await flushMemoryBuffer();
  }
}

async function wasAlreadyScaled(symbol: string): Promise<boolean> {
  const row = await db.select({ whatWorked: tradeMemoryTable.whatWorked })
    .from(tradeMemoryTable)
    .where(and(eq(tradeMemoryTable.symbol, symbol), eq(tradeMemoryTable.whatWorked, "ADD")))
    .orderBy(desc(tradeMemoryTable.createdAt))
    .limit(1)
    .then(r => r[0]);
  return !!row;
}

// ── Position review (HOLD / ADD / CUT existing positions) ────────────────────

interface PositionDecision {
  symbol:         string;
  action:         "HOLD" | "ADD" | "CUT";
  reason:         string;
  ruleOverridden?: number;
  overrideReason?: string;
}

function bybitSym(sym: string): string {
  const s = sym.toUpperCase().replace(/[-/]/g, "").replace(/[^A-Z0-9]/g, "");
  return s.endsWith("USDT") || s.endsWith("USDC") ? s : `${s}USDT`;
}

async function makePositionReview(
  opps:          ScanResult["opportunities"],
  livePositions: BybitPosition[],
  bybitBalance:  number,
): Promise<{ positions: PositionDecision[] }> {
  if (!livePositions.length) return { positions: [] };
  const activeRules = await getActiveRules().catch(() => [] as Awaited<ReturnType<typeof getActiveRules>>);

  const signalContext = opps.slice(0, 5)
    .map(s => {
      const dir = s.direction ?? "?";
      const label = dir === "short"
        ? (s.score ?? 0) >= 80 ? "STRONG SELL" : "SELL"
        : s.recommendation;
      return `${s.symbol} ${label} score=${s.score} direction=${dir}`;
    })
    .join(", ");

  const enriched = await Promise.allSettled(
    livePositions.map(async pos => {
      const [frRes, klRes] = await Promise.allSettled([
        getFundingRate(pos.symbol),
        getKlines(pos.symbol, "60", 50),
      ]);

      const direction = pos.side === "Buy" ? "LONG" : "SHORT";
      const frRate = frRes.status === "fulfilled" ? frRes.value.rate : 0;
      const frPct  = (frRate * 100).toFixed(4);
      const frSign = frRate >= 0 ? "+" : "";
      const frNote = pos.side === "Buy"
        ? (frRate < 0  ? `funding ${frSign}${frPct}% — supports LONG (shorts paying)`
                       : `funding ${frSign}${frPct}% — opposes LONG (longs paying, crowded)`)
        : (frRate > 0  ? `funding ${frSign}${frPct}% — supports SHORT (longs paying, crowded)`
                       : `funding ${frSign}${frPct}% — opposes SHORT (shorts paying)`);

      let keyLevelNote = "no kline data";
      if (klRes.status === "fulfilled") {
        const closes       = klRes.value.map(k => k.close);
        const currentPrice = closes[closes.length - 1] ?? pos.entryPrice;
        const ema20        = calcEMA(closes, 20);
        const ema50        = calcEMA(closes, 50);
        const pctEma20     = Math.abs((currentPrice - ema20) / ema20 * 100);
        const pctEma50     = Math.abs((currentPrice - ema50) / ema50 * 100);
        if (pctEma20 < 1.5)       keyLevelNote = `price at EMA20=$${ema20.toFixed(4)} (±${pctEma20.toFixed(1)}%)`;
        else if (pctEma50 < 2.0)  keyLevelNote = `price at EMA50=$${ema50.toFixed(4)} (±${pctEma50.toFixed(1)}%)`;
        else if (pos.side === "Sell" && currentPrice >= ema20 && currentPrice >= ema50)
          keyLevelNote = `price $${currentPrice.toFixed(4)} ABOVE EMA20+EMA50 — resistance zone (favours short)`;
        else if (pos.side === "Buy" && currentPrice <= ema20 && currentPrice <= ema50)
          keyLevelNote = `price $${currentPrice.toFixed(4)} BELOW EMA20+EMA50 — support zone (favours long)`;
        else keyLevelNote = `price $${currentPrice.toFixed(4)} EMA20=$${ema20.toFixed(4)} EMA50=$${ema50.toFixed(4)}`;
      }
      return { direction, frNote, keyLevelNote };
    })
  );

  const positionLines = livePositions.map((p, i) => {
    const pnlStr = `${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)} (${p.pnlPct.toFixed(2)}%)`;
    const slStr  = p.stopLoss  ? ` SL=$${p.stopLoss}`                                          : "";
    const tpStr  = p.takeProfit ? ` TP=$${p.takeProfit}`                                       : "";
    const liqStr = p.liqPrice  ? ` Liquidation=$${p.liqPrice.toFixed(4)}`                      : "";
    const ctx    = enriched[i];
    if (ctx?.status === "fulfilled") {
      const { direction, frNote, keyLevelNote } = ctx.value;
      return [
        `- ${p.symbol} ${direction} ${p.leverage}x entry=$${p.entryPrice.toFixed(4)} P/L=${pnlStr}${slStr}${tpStr}${liqStr}`,
        `  Key level: ${keyLevelNote}`,
        `  Funding:   ${frNote}`,
      ].join("\n");
    }
    return `- ${p.symbol} ${p.side === "Buy" ? "LONG" : "SHORT"} ${p.leverage}x entry=$${p.entryPrice.toFixed(4)} P/L=${pnlStr}${slStr}${tpStr}${liqStr}`;
  }).join("\n");

  const addRule = bybitBalance < 200
    ? `ADD rule: balance $${bybitBalance.toFixed(2)} < $200 — NEVER ADD to existing positions. Return HOLD instead of ADD always. Single-entry precision only.`
    : `ADD rule: balance $${bybitBalance.toFixed(2)} >= $200 — ADD only on strongest conviction (+3% P/L) with clear trend continuation, not already scaled.`;

  const rulesSection = activeRules.length
    ? [
        "",
        "═══ ACTIVE TRADING RULES ═══",
        ...activeRules.map(r => `Rule ${r.ruleNumber} [${r.confidence}]: ${r.ruleText}`),
        "These are SOFT rules. If overriding one, include ruleOverridden (number) and overrideReason in your JSON response.",
      ].join("\n")
    : "";

  const signalTruthTable = [
    "SIGNAL TRUTH TABLE — direction-aware interpretation (MUST apply before any decision):",
    "  Price at support       → LONG: HOLD (thesis intact) | SHORT: WARNING (bounce risk)",
    "  Price at resistance    → LONG: WARNING (rejection risk) | SHORT: HOLD (thesis intact)",
    "  RSI > 70               → LONG: caution (overbought) | SHORT: HOLD (still bearish pressure)",
    "  RSI < 30               → LONG: HOLD (still bullish pressure) | SHORT: caution (oversold bounce risk)",
    "  Funding rate positive  → LONG: WARNING (squeeze risk) | SHORT: GOOD (being paid to hold)",
    "  Funding rate negative  → LONG: GOOD (being paid to hold) | SHORT: WARNING (squeeze risk)",
    "  OI rising + price up   → LONG: bullish (real demand) | SHORT: PAIN (conviction needed to hold)",
    "  OI rising + price down → LONG: bearish (real supply) | SHORT: BULLISH (genuine selling)",
    "  BTC green              → LONG: tailwind | SHORT: headwind",
    "  BTC red                → LONG: headwind | SHORT: tailwind",
    "NEVER apply LONG signal logic to a SHORT position or vice versa. A bearish signal is GOOD for shorts.",
  ].join("\n");

  const systemContext = [
    "You are a disciplined quant managing a Bybit live futures account. Respond JSON only.",
    "",
    signalTruthTable,
    "",
    "LONG position: profitable when price rises. HOLD if: bullish momentum intact, price above support, funding supports long.",
    "SHORT position: profitable when price falls. HOLD if: bearish momentum intact, price at/below resistance, funding supports short, NO bullish reversal.",
    "CRITICAL for SHORT: price hitting resistance = thesis intact = HOLD. Bearish signals = GOOD for short = HOLD. Bullish signals = threat = CUT.",
    "CRITICAL for LONG: price at support = HOLD. Bullish signals = HOLD. Bearish breakdown = CUT.",
    "NEVER apply long logic to short positions or vice versa.",
    "",
    addRule,
    "CUT is only justified if: (1) loss exceeds -8%, OR (2) opposing signal scores >=80, OR (3) price breaks key support/resistance with volume >3× average (structural break). Minor adverse moves (-0.2% to -2%) with no structural break = HOLD. Let SL do its job.",
    rulesSection,
  ].join("\n");

  const prompt = [
    `Market signals: ${signalContext}`,
    ``,
    `EXISTING POSITIONS (${livePositions.length}):`,
    positionLines,
  ].join("\n");

  const res = await llm.json<{ positions: PositionDecision[] }>({
    taskType:      "position_review",
    systemContext,
    prompt,
    schema: {
      type: "object", required: ["positions"],
      properties: {
        positions: {
          type: "array",
          items: {
            type: "object", required: ["symbol", "action", "reason"],
            properties: {
              symbol:         { type: "string" },
              action:         { type: "string", enum: ["HOLD", "ADD", "CUT"] },
              reason:         { type: "string" },
              ruleOverridden: { type: "number" },
              overrideReason: { type: "string" },
            },
          },
        },
      },
    },
    fallback: { positions: [] },
  });

  if (!res.parseSuccess) {
    await alertFn?.("⚠️ Position review parse failed — defaulting to HOLD for all positions").catch(e => console.error("[telegram] Send failed:", (e as Error).message));
  }

  return res.data;
}

async function handlePositionDecision(
  decision:      PositionDecision,
  livePositions: BybitPosition[],
  bybitBalance:  number,
  outcomes:      SignalOutcome[],
  opps:          ScanOpportunity[],
): Promise<void> {
  const sym = decision.symbol;
  const pos = livePositions.find(p =>
    p.symbol === sym || p.symbol === bybitSym(sym) || bybitSym(p.symbol) === bybitSym(sym)
  );

  if (!pos) {
    console.log(`[cronScanner] ${sym} position not found for action ${decision.action}`);
    return;
  }

  // Store rule override if Claude reported one
  if (decision.ruleOverridden) {
    const [rule] = await db.select({ id: tradingRulesTable.id, confidence: tradingRulesTable.confidence })
      .from(tradingRulesTable)
      .where(and(eq(tradingRulesTable.ruleNumber, decision.ruleOverridden), eq(tradingRulesTable.active, true)))
      .limit(1)
      .catch(() => []);
    if (rule) {
      await db.insert(ruleOverridesTable).values({
        ruleId:           rule.id,
        symbol:           sym,
        direction:        pos.side === "Buy" ? "long" : "short",
        overrideReason:   decision.overrideReason ?? decision.reason,
        tradeResult:      "pending",
        confidenceBefore: rule.confidence,
      }).catch(() => {});
      console.log(`[cronScanner] Rule ${decision.ruleOverridden} overridden on ${sym}: ${(decision.overrideReason ?? decision.reason).slice(0, 80)}`);
    }
  }

  if (decision.action === "HOLD") {
    await logScalingDecision(sym, "HOLD", decision.reason, pos.pnlPct);
    outcomes.push({ symbol: sym, action: "HOLD", reason: decision.reason, pnlPct: pos.pnlPct });
    return;
  }

  if (decision.action === "CUT") {
    // Block low-conviction CUT: require pnlPct <= -8% OR a direct opposing signal with score >= 80
    const opposingDir = pos.side === "Buy" ? "short" : "long";
    const bSym = bybitSym(sym);
    const opposingSignal = opps.find(o =>
      (bybitSym(o.symbol) === bSym || o.symbol === sym) &&
      o.direction === opposingDir &&
      (o.score ?? 0) >= 80
    );
    if ((pos.pnlPct ?? 0) > -8 && !opposingSignal) {
      console.log(`[cronScanner] ${sym} CUT blocked — pnlPct=${(pos.pnlPct ?? 0).toFixed(2)}% > -8% and no opposing signal score>=80 → HOLD`);
      await logScalingDecision(sym, "HOLD", `CUT blocked: pnlPct=${(pos.pnlPct ?? 0).toFixed(2)}% and no high-score opposing signal`, pos.pnlPct);
      outcomes.push({ symbol: sym, action: "HOLD", reason: `CUT blocked (${(pos.pnlPct ?? 0).toFixed(2)}% loss, no >=80 opposing signal)`, pnlPct: pos.pnlPct });
      return;
    }
    try {
      await bybitClose(sym);
      const preOrderPrice = pos.entryPrice + (pos.pnl / Math.max(pos.size, 0.0001));
      const exitPrice = await fetchActualFillPrice(sym, pos.entryPrice, preOrderPrice);
      await closeOpenTrade({ symbol: sym, broker: "bybit", exitPrice, amountUsd: pos.size * pos.entryPrice, entryPriceOverride: pos.entryPrice, directionOverride: pos.side === "Buy" ? "long" : "short", exitReason: "review" }).catch(() => {});
      await clearPositionMeta(sym).catch(() => {});
      await logScalingDecision(sym, "CUT", decision.reason, pos.pnlPct);
      outcomes.push({ symbol: sym, action: "CUT", reason: decision.reason, pnlPct: pos.pnlPct });
      const sign = pos.pnl >= 0 ? "+" : "";
      await alertFn?.(`✂️ Position CUT: ${sym}\nP/L: ${sign}$${pos.pnl.toFixed(2)} (${sign}${pos.pnlPct.toFixed(2)}%)\nReason: ${escapeHtml(decision.reason ?? "")}`).catch(e => console.error("[telegram] Send failed:", (e as Error).message));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cronScanner] CUT ${sym} failed:`, msg);
      outcomes.push({ symbol: sym, action: "HOLD", reason: `CUT failed: ${msg}` });
    }
    return;
  }

  if (decision.action === "ADD") {
    // Hard rule: no ADD below $200
    if (bybitBalance < 200) {
      outcomes.push({ symbol: sym, action: "HOLD", reason: "Balance < $200 — ADD blocked", pnlPct: pos.pnlPct });
      return;
    }
    if (await wasAlreadyScaled(sym)) {
      outcomes.push({ symbol: sym, action: "HOLD", reason: "Already scaled once — no further ADD", pnlPct: pos.pnlPct });
      return;
    }
    const riskSize = calcRMultipleSizing(bybitBalance, pos.entryPrice, pos.stopLoss ?? 0, pos.leverage, 65, "NO_CONFLICT", "EARLY", "MEDIUM");
    const proposal = buildProposal({
      symbol:       sym,
      side:         pos.side === "Buy" ? "buy" : "sell",
      amountUsd:    riskSize,
      assetClass:   "Crypto",
      broker:       "bybit",
      rationale:    `[Cron/Scale] ADD to winner: ${decision.reason}`,
      currentPrice: pos.entryPrice,
    });
    const gateResult = await approvalGate.submit(proposal).catch(e => ({
      action: "failed" as const, message: String(e), proposal, orderId: undefined,
    }));
    if (gateResult.action === "executed" || gateResult.action === "queued") {
      await logScalingDecision(sym, "ADD", decision.reason, pos.pnlPct);
    }
    outcomes.push({ symbol: sym, action: gateResult.action === "executed" ? "ADD" : "HOLD", reason: gateResult.message, pnlPct: pos.pnlPct });
  }
}

// ── Position metadata clear (call on every full close) ───────────────────────
async function clearPositionMeta(symbol: string): Promise<void> {
  const state = await loadBotState();
  const meta  = (state?.positionMetadata ?? {}) as Record<string, PositionMeta>;
  delete meta[symbol];
  if (_botStateCache) _botStateCache = { ..._botStateCache, positionMetadata: meta } as typeof _botStateCache;
  await db.update(botStateTable)
    .set({ positionMetadata: meta, lastUpdated: new Date() })
    .where(eq(botStateTable.id, 1));
  console.log(`[metadata] Cleared ${symbol} on close`);
}

// ── Position metadata patch (merges partial updates) ─────────────────────────
async function patchPositionMeta(symbol: string, updates: Partial<PositionMeta>): Promise<void> {
  _botStateCache = null; // force fresh DB read — storePositionMeta (startup.ts) writes directly to DB without updating this cache
  const state = await loadBotState();
  const meta  = (state?.positionMetadata ?? {}) as Record<string, PositionMeta>;
  meta[symbol] = { ...(meta[symbol] ?? {} as PositionMeta), ...updates };
  if (_botStateCache) _botStateCache = { ..._botStateCache, positionMetadata: meta } as typeof _botStateCache;
  await db.update(botStateTable)
    .set({ positionMetadata: meta, lastUpdated: new Date() })
    .where(eq(botStateTable.id, 1));
}

// ── Entry source tagging ──────────────────────────────────────────────────────
async function patchEntrySource(symbol: string, source: "manual_nl" | "auto_scan"): Promise<void> {
  _botStateCache = null; // force fresh DB read — same race as patchPositionMeta
  const state = await loadBotState();
  const meta  = (state?.positionMetadata ?? {}) as Record<string, PositionMeta>;
  meta[symbol] = { ...(meta[symbol] ?? {} as PositionMeta), entrySource: source };
  if (_botStateCache) _botStateCache = { ..._botStateCache, positionMetadata: meta } as typeof _botStateCache;
  await db.update(botStateTable)
    .set({ positionMetadata: meta, lastUpdated: new Date() })
    .where(eq(botStateTable.id, 1));
}

// ── Manual review gate (sends Telegram request, awaits approval, 10-min timeout → HOLD) ──
async function gateManualReview(
  symbol:   string,
  decision: string,
  reason:   string,
  pnlPct:   number,
): Promise<boolean> {
  if (!reviewFn) return true; // no notifier registered → auto-approve

  const reviewId = `rev_${symbol}_${Date.now()}`;
  const pnlPctStr = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}`;

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingReviews.delete(reviewId);
      resolve(false); // timeout → HOLD
    }, 15 * 60 * 1000);

    pendingReviews.set(reviewId, { resolve, timer });

    reviewFn!(symbol, decision, reason, pnlPctStr, reviewId).catch(() => {
      clearTimeout(timer);
      pendingReviews.delete(reviewId);
      resolve(false);
    });
  });
}

// ── Format scan summary for Telegram ─────────────────────────────────────────
function formatScanSummary(
  outcomes:      SignalOutcome[],
  signalCount:   number,
  regime:        ScanResult["regime"],
  rejected:       Array<{ symbol: string; reason: string }>,
  dailyPnl:       number,
  balance:        number,
  openPositions:  number,
  signalsPassed:  number,
  opps:           ScanOpportunity[],
): string {
  const regimeEmoji: Record<string, string> = {
    STRONG_TREND: "🚀", TRENDING_UP: "📈", TRENDING_DOWN: "📉",
    RANGING: "↕️", CHOPPY: "↔️", EXHAUSTION: "⚠️", VOLATILE: "⚡",
  };
  const re = regime ? `${regimeEmoji[regime.regime] ?? "?"} ${regime.regime} | ADX:${regime.adx.toFixed(0)}` : "? Unknown";
  const pct = balance > 0 ? (dailyPnl / balance * 100).toFixed(1) : "?";
  const dailyTag = `${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)} (${dailyPnl >= 0 ? "+" : ""}${pct}%)`;

  const newEntries = outcomes.filter(o => o.action === "NEW" || o.action === "ADD");
  const holds      = outcomes.filter(o => o.action === "HOLD");
  const cuts       = outcomes.filter(o => o.action === "CUT");

  const lines = [
    `🔍 <b>Scan complete</b> — ${re}`,
    ``,
  ];

  // Top 5 scores (executed symbols shown separately below)
  const threshold    = getRegimeThreshold(regime?.regime);
  const executedSyms = new Set(newEntries.map(o => o.symbol));
  const top5 = [...opps]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .filter(o => !executedSyms.has(bybitSym(o.symbol)))
    .slice(0, 5);
  if (top5.length) {
    lines.push(`📊 <b>Top scores</b> (${regime?.regime ?? "?"}):`);
    for (const o of top5) {
      const dir   = o.direction === "short" ? "🔻" : o.direction === "long" ? "🔺" : "↔️";
      const label = o.direction === "short" ? "SHORT" : o.direction === "long" ? "LONG" : "WATCH";
      lines.push(`  ${o.symbol} ${dir} ${label} — ${o.score}`);
    }
    lines.push(``);
  }

  // Position review section — always shown when there are holds or cuts
  const positionOutcomes = [...holds, ...cuts];
  if (positionOutcomes.length) {
    lines.push(`📊 <b>Position review (${positionOutcomes.length}):</b>`);
    for (const o of holds) {
      lines.push(`  • ${o.symbol} — HOLD${o.reason ? ` (${escapeHtml(o.reason)})` : ""}`);
    }
    for (const o of cuts) {
      const pnlTag = o.pnlPct != null ? ` ${o.pnlPct >= 0 ? "+" : ""}${o.pnlPct.toFixed(1)}%` : "";
      lines.push(`  • ${o.symbol} — CUT${pnlTag}${o.reason ? ` (${escapeHtml(o.reason)})` : ""}`);
    }
    lines.push(``);
  }

  // New entries executed
  if (newEntries.length) {
    lines.push(`✅ <b>Executed (${newEntries.length}):</b>`);
    for (const o of newEntries) lines.push(`  • ${o.symbol} ${o.action} — $${o.amount ?? "?"}`);
    lines.push(``);
  }

  // Filtered signals
  if (rejected.length) {
    lines.push(`🚫 <b>Filtered (${rejected.length}):</b>`);
    for (const r of rejected) lines.push(`  • ${r.symbol} — ${r.reason}`);
    lines.push(``);
  }

  // New signals result
  if (signalsPassed > 0) {
    lines.push(`📈 <b>New signals:</b> ${signalsPassed} passed filters → ${newEntries.length} executed`);
  } else if (signalCount > 0) {
    lines.push(`📈 <b>New signals:</b> none passed filters (${signalCount} scanned)`);
  } else {
    lines.push(`📈 <b>New signals:</b> none`);
  }

  // Watch: sweep/squeeze detected or explicit WATCH recommendation
  console.log("[scanSummary] Watch candidates:", opps.filter(o => o.sweepDetected || o.squeezeDetected).map(o => `${o.symbol}(sweep=${String(o.sweepDetected)},squeeze=${String(o.squeezeDetected)},score=${o.score})`).join(", ") || "none");
  const watched = [...opps]
    .filter(o => o.recommendation === "WATCH" || o.sweepDetected || o.squeezeDetected)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 3);
  if (watched.length) {
    lines.push(``);
    lines.push(`👀 <b>Watch:</b>`);
    for (const o of watched) {
      const reason = o.sweepDetected ? "sweep detected" : o.squeezeDetected ? "squeeze setup" : "setup forming";
      const adx    = regime?.adx ?? 0;
      const cond   = adx < 25 ? `enter if ADX > 25` : `confirm on 1h breakout`;
      lines.push(`  ${o.symbol} — ${reason}, ${cond}`);
    }
  }

  lines.push(``);
  lines.push(`💰 Daily P/L: ${dailyTag}`);
  lines.push(`💼 Positions: ${openPositions} open | Balance: $${balance.toFixed(2)}`);

  return lines.join("\n");
}

// ── Watch list 30-min rescan ──────────────────────────────────────────────────

async function removeFromWatchList(symbol: string): Promise<void> {
  const state = await loadBotState();
  const updated = (state.watchList ?? []).filter(w => w.symbol !== symbol);
  await saveBotState({ watchList: updated });
}

function stopWatchScan(): void {
  if (watchScanTask) {
    watchScanTask.stop();
    watchScanTask = null;
    watchScanNextAt = null;
    console.log("[watchScan] Rescan stopped");
  }
}

async function runWatchScan(): Promise<void> {
  const state = await loadBotState().catch(() => null);
  const watchCoins = (state?.watchList ?? []) as WatchCoin[];

  if (!watchCoins.length) {
    console.log("[watchScan] Watch list empty — stopping");
    stopWatchScan();
    return;
  }

  const [positions, balances] = await Promise.all([
    bybitGetPositions().catch(() => [] as BybitPosition[]),
    syncTotalCapitalToDB().catch(() => null),
  ]);
  const bybitBalance = (balances?.bybit ?? 0) > 0 ? balances!.bybit : 41;

  if (bybitBalance < 5) {
    console.log(`[watchScan] Balance $${bybitBalance.toFixed(2)} < $5 — stopping`);
    stopWatchScan();
    return;
  }

  const symbols = [...new Set(watchCoins.map(w => bybitSym(w.symbol)))];
  console.log(`[watchScan] Rescanning ${symbols.length} coins: ${symbols.join(", ")}`);

  const result = await runFocusedScan(symbols).catch(e => {
    console.error("[watchScan] Focused scan failed:", e);
    return null;
  });
  if (!result) return;

  const regime    = result.regime;
  const threshold = getRegimeThreshold(regime?.regime);
  const executedSyms = new Set<string>(); // intra-run dedup
  const posMeta = (state?.positionMetadata ?? {}) as Record<string, PositionMeta>;

  for (const signal of result.opportunities) {
    const sym       = bybitSym(signal.symbol);
    const watchCoin = watchCoins.find(w => bybitSym(w.symbol) === sym);
    if (!watchCoin) continue;

    // Intra-run dedup: symbol was executed/queued earlier in this watchScan loop
    if (executedSyms.has(sym)) {
      console.log(`[watchScan] Skipping ${sym} — already executed in this run`);
      continue;
    }

    const existingPos = positions.find(p => bybitSym(p.symbol) === sym);
    if (existingPos) {
      const existingDir = existingPos.side === "Buy" ? "long" : "short";
      const signalDir   = signal.direction ?? "long";

      if (existingDir === signalDir) {
        console.log(`[watchScan] Skipping duplicate — ${sym} ${signalDir} already open`);
        await removeFromWatchList(signal.symbol);
        continue;
      }

      // Opposite direction conflict
      const existingPnlPct  = existingPos.pnlPct;
      const existingScore   = posMeta[sym]?.score ?? 0;
      const scoreDiff       = (signal.score ?? 0) - existingScore;

      if (existingPnlPct > 0 && scoreDiff < 15) {
        console.log(`[watchScan] Skipping ${sym} ${signalDir} — existing ${existingDir} profitable (${existingPnlPct.toFixed(1)}%) and new score (${signal.score}) not significantly better than existing (${existingScore})`);
        continue;
      }

      if (existingPnlPct < -5 || scoreDiff >= 15) {
        const rec = existingPnlPct > 0
          ? "Keep existing — still profitable"
          : "Consider switching — existing is losing";
        await alertFn?.([
          `⚠️ <b>Direction conflict — ${sym}</b>`,
          ``,
          `Existing: <b>${existingDir.toUpperCase()}</b>  P/L: ${existingPnlPct.toFixed(1)}%  Score: ${existingScore}`,
          `New signal: <b>${signalDir.toUpperCase()}</b>  Score: ${signal.score}`,
          `Why: ${escapeHtml(signal.whyNow ?? (signal.reasoning ?? "").slice(0, 120))}`,
          ``,
          `Recommendation: ${rec}`,
        ].join("\n")).catch(() => {});
        console.log(`[watchScan] Conflict notification sent for ${sym}`);
        continue;
      }

      // Slight loss, low score diff — no strong case to flip
      console.log(`[watchScan] Skipping ${sym} ${signalDir} — existing position present, no strong case to flip`);
      continue;
    }

    if ((signal.score ?? 0) >= threshold) {
      // Score crossed threshold — execute
      if (await isCoinSuspended(signal.symbol)) { await removeFromWatchList(signal.symbol); continue; }

      // Hard gate — SL/TP/setupType/score required before any order
      {
        const gateRequired: Record<string, unknown> = {
          stopLoss:  signal.stopLoss,
          tp1:       signal.tp1,
          setupType: signal.setupType,
          score:     signal.score,
        };
        const gateMissing = Object.entries(gateRequired)
          .filter(([, v]) => typeof v === 'number' ? v <= 0 : !v)
          .map(([k]) => k);
        if (gateMissing.length > 0) {
          console.log(`[gate] REJECTED ${sym} (watchScan) — missing required fields: ${gateMissing.join(", ")}`);
          alertFn?.([
            `🚫 Entry rejected — ${sym}`,
            `Missing: ${gateMissing.join(", ")}`,
            `No trade without SL/TP/setup type.`,
          ].join("\n")).catch(() => {});
          await removeFromWatchList(signal.symbol);
          continue;
        }
      }

      // Hard gate — downtrend long block (mirrors applyHardFilters; watchScan bypasses that path)
      if (signal.direction === "long") {
        const r           = regime?.regime;
        const bearishStrong = r === "STRONG_TREND" && (regime?.diMinus ?? 0) > (regime?.diPlus ?? 0);
        if (r === "TRENDING_DOWN" || bearishStrong) {
          const detail = `${r} DI- ${regime?.diMinus?.toFixed(1)} > DI+ ${regime?.diPlus?.toFixed(1)}`;
          console.log(`[gate] REJECTED ${sym} (watchScan) — downtrend gate: LONG blocked (${detail})`);
          await removeFromWatchList(signal.symbol);
          continue;
        }
      }

      // R:R gate — blended reward across both exits (more reliable than Claude's reported field)
      {
        const rrEntry  = signal.entry ?? signal.price;
        const riskDist = Math.abs(rrEntry - (signal.stopLoss ?? 0));
        const tp1Frac  = (signal.tp1ClosePercent ?? 30) / 100;
        const tp2Frac  = (1 - tp1Frac) * (signal.tp2ClosePercent ?? 100) / 100;
        const rewardDist = tp1Frac * Math.abs((signal.tp1 ?? 0) - rrEntry)
                         + tp2Frac * Math.abs((signal.tp2 ?? 0) - rrEntry);
        const rrRatio  = riskDist > 0 ? rewardDist / riskDist : 0;
        if (rrRatio < 1.1) {
          console.log(`[gate] REJECTED ${sym} (watchScan) — R:R ${rrRatio.toFixed(2)} < 1.1`);
          alertFn?.([
            `🚫 Entry rejected — ${sym}`,
            `Reward:Risk ${rrRatio.toFixed(2)} below minimum 1.1`,
          ].join("\n")).catch(() => {});
          await removeFromWatchList(signal.symbol);
          continue;
        }
      }

      const amountUsd = calcRMultipleSizing(
        bybitBalance,
        signal.entry ?? signal.price,
        signal.stopLoss ?? 0,
        signal.leverage ?? 10,
        signal.score ?? 65,
        signal.conflictResolution ?? "NO_CONFLICT",
        signal.timing ?? "EARLY",
        signal.setupQuality ?? "MEDIUM",
      );
      if (amountUsd > 0) {
        const proposal = buildProposal({
          symbol:          sym,
          side:            signal.direction === "short" ? "sell" : "buy",
          amountUsd,
          assetClass:      signal.assetClass,
          broker:          "bybit",
          rationale:       `[WatchScan] score=${signal.score} regime=${regime?.regime ?? "?"}. ${signal.reasoning ?? ""}`,
          score:           signal.score,
          currentPrice:    signal.price,
          dataTimestamp:   signal.dataTimestamp,
          stopLossPrice:    signal.stopLoss,
          takeProfitPrice:  signal.tp2 ?? signal.takeProfit,
          tp1Price:         signal.tp1,
          tp1ClosePercent:  signal.tp1ClosePercent,
          tp2ClosePercent:  signal.tp2ClosePercent,
        });
        const gateResult = await approvalGate.submit(proposal).catch(e => {
          console.error(`[watchScan] submit ${sym}:`, e);
          return { action: "failed" as const, proposal, message: String(e), orderId: undefined };
        });

        if (gateResult.action === "executed" || gateResult.action === "queued") {
          executedSyms.add(sym);
        }
        if (gateResult.action === "executed") {
          patchEntrySource(sym, "auto_scan").catch(() => {});
          patchPositionMeta(sym, { score: signal.score ?? 0 }).catch(() => {});

          // Verify metadata completeness, confirm fill on Bybit, then log trade.
          // logOpenTrade is deferred 5s so we can verify the position exists before creating a record.
          setTimeout(async () => {
            const s2   = await loadBotState().catch(() => null);
            const pm   = ((s2?.positionMetadata ?? {}) as Record<string, PositionMeta>)[sym];
            const required: (keyof PositionMeta)[] = ["tp1", "sl", "originalQty"];
            const missing = required.filter(f => !pm?.[f as keyof PositionMeta]);
            const livePositions = await bybitGetPositions().catch(() => [] as BybitPosition[]);
            const pos2 = livePositions.find(p => p.symbol === sym);
            if (missing.length > 0) {
              console.log(`[watchScan] ⚠️ Missing metadata for ${sym}: ${missing.join(", ")} — applying ATR fallback`);
              if (pos2) {
                const dir = pos2.side === "Buy" ? "long" : "short" as "long" | "short";
                await applyAtrSlTp(sym, dir, pos2.entryPrice, pos2.positionIdx, pos2.size)
                  .catch(e => console.warn(`[watchScan] applyAtrSlTp fallback ${sym}:`, (e as Error).message));
              }
            }
            // Guard: verify entry on Bybit before logging. Market orders require live position;
            // limit orders require the orderId to exist in open orders.
            let confirmed = !!pos2;
            if (!confirmed) {
              if (pendingLimitFills.has(sym)) {
                const openOrders = await bybitGetOrders().catch(() => [] as Awaited<ReturnType<typeof bybitGetOrders>>);
                const orderOnBybit = openOrders.find(o => o.orderId === gateResult.orderId && o.symbol === sym);
                if (orderOnBybit) {
                  confirmed = true;
                  console.log(`[watchScan] ${sym} limit order confirmed on Bybit`);
                } else {
                  pendingLimitFills.delete(sym);
                }
              }
              if (!confirmed) {
                console.warn(`[watchScan] ⚠️ Silent entry failure ${sym}: no position after 5s — skipping logOpenTrade`);
                await alertFn?.([`⚠️ SILENT ENTRY FAIL: ${sym} — not on Bybit. NOT logged.`]).catch(() => {});
                return;
              }
            }
            const newTradeId = await logOpenTrade({
              symbol:    sym,
              broker:    "bybit",
              direction: pos2 ? (pos2.side === "Buy" ? "long" : "short") : (signal.direction === "short" ? "short" : "long"),
              entryPrice: pos2?.entryPrice ?? signal.entry ?? signal.price,
              leverage:  pos2?.leverage ?? signal.leverage ?? 10,
              amountUsd: pos2 ? pos2.size * pos2.entryPrice / pos2.leverage : amountUsd,
              reasoning: `[WatchScan] score=${signal.score} regime=${regime?.regime ?? "?"} whyNow=${signal.whyNow ?? signal.reasoning?.slice(0, 200) ?? ""}`,
              stopLoss:  signal.stopLoss,
              takeProfit: signal.takeProfit,
            }).catch(() => null);
            if (pos2) {
              console.log(`[trade] Entry reconciled ${sym}: planned $${signal.entry ?? signal.price} → actual $${pos2.entryPrice} | leverage: ${signal.leverage ?? 10}× → ${pos2.leverage}×`);
            }
            await db.update(tradeLogTable)
              .set({
                tp1:              signal.tp1      ? String(signal.tp1)      : null,
                tp2:              signal.tp2      ? String(signal.tp2)      : null,
                sl:               signal.stopLoss ? String(signal.stopLoss) : null,
                atr:              signal.atr      ? String(signal.atr)      : null,
                setupType:        signal.setupType ?? null,
                score:            signal.score    ? String(signal.score)    : null,
                whyNow:           signal.whyNow   ?? null,
                blowoffSuspected: signal.blowoffSuspected ? "1" : null,
              })
              .where(newTradeId
                ? eq(tradeLogTable.id, newTradeId)
                : and(eq(tradeLogTable.symbol, sym), isNull(tradeLogTable.exitAt)))
              .catch(e => console.warn(`[watchScan] trade_log tp patch ${sym}:`, e.message));
          }, 5000);

          await alertFn?.([
            `⚡ <b>Watch list entry — ${sym} ${(signal.direction ?? "?").toUpperCase()}</b>`,
            `Score: ${watchCoin.score} → <b>${signal.score}</b> ✅`,
            `Threshold met: ${signal.score} ≥ ${threshold}`,
            `Edge: ${escapeHtml(signal.whyNow ?? signal.reasoning?.slice(0, 100) ?? "?")}`,
            `Entry: $${signal.entry ?? signal.price} | SL: $${signal.stopLoss?.toFixed(4) ?? "?"} | TP1: $${signal.tp1?.toFixed(4) ?? "?"}`,
          ].join("\n")).catch(() => {});
        }
      }
      await removeFromWatchList(signal.symbol);

    } else if ((signal.score ?? 0) < 55) {
      // Score dropped significantly — remove from watch list
      await removeFromWatchList(signal.symbol);
      await alertFn?.([
        `👁️ <b>Watch removed — ${sym}</b>`,
        `Score dropped: ${watchCoin.score} → ${signal.score ?? "?"}`,
        `Setup no longer valid`,
      ].join("\n")).catch(() => {});
      console.log(`[watchScan] ${sym} score dropped to ${signal.score ?? "?"} — removed from watch`);

    } else {
      console.log(`[watchScan] ${sym} score ${signal.score ?? "?"} — still watching`);
    }
  }

  // Stop if watch list now empty
  const updatedState = await loadBotState().catch(() => null);
  if (!(updatedState?.watchList ?? []).length) {
    stopWatchScan();
  }
}

function startWatchScan(): void {
  if (watchScanTask) return; // already running
  watchScanTask = cron.schedule("*/30 * * * *", () => {
    watchScanNextAt = new Date(Date.now() + 30 * 60 * 1000);
    void runWatchScan().catch(e => console.error("[watchScan] unhandled:", e));
  });
  watchScanNextAt = new Date(Date.now() + 30 * 60 * 1000);
  console.log("[watchScan] 30-min rescan started");
}

export function getWatchScanStatus(): { active: boolean; nextAt: Date | null } {
  return { active: watchScanTask !== null, nextAt: watchScanNextAt };
}

export async function getWatchList(): Promise<WatchCoin[]> {
  const state = await loadBotState().catch(() => null);
  return (state?.watchList ?? []) as WatchCoin[];
}

// ── Core scan logic ───────────────────────────────────────────────────────────
async function runCronScan(triggered: "cron" | "manual" = "cron"): Promise<void> {
  if (!cronEnabled && triggered === "cron") { console.log("[cronScanner] Skipped — disabled"); return; }
  if (tradingPaused)                         { console.log("[cronScanner] Skipped — trading paused"); return; }
  if (isScanning)                            { console.log("[cronScanner] Skipped — scan already in progress"); return; }

  stopWatchScan(); // stop any running watch scan — will restart after this scan completes
  isScanning = true;
  console.log(`[cronScanner] ${triggered === "manual" ? "Manual" : "Cron"} scan starting…`);
  lastScanTime = new Date();
  cache.invalidate(CacheKey.marketScan());

  try {
    // Sync live broker balances
    const balances      = await syncTotalCapitalToDB().catch(() => null);
    const bybitBalance  = (balances?.bybit ?? 0) > 0 ? balances!.bybit : 41; // fallback to last known

    // Layer 5: daily loss / peak drawdown check
    const safe = await checkDailyLossLimit(bybitBalance);
    if (!safe) return;

    // Cancel stale limit orders
    await cancelStaleOrders().catch(e => console.warn("[cronScanner] stale order check:", e.message));

    const result         = await runScan();
    const regime         = result.regime;
    const livePositions  = await bybitGetPositions().catch(() => [] as BybitPosition[]);

    // Layer 5: regime change flattener
    await checkRegimeFlattener(regime, livePositions).catch(e =>
      console.error("[cronScanner] regimeFlattener:", e)
    );

    // Layer 5: partial exit tier checks
    await checkPartialExits(livePositions).catch(e =>
      console.error("[cronScanner] partialExits:", e)
    );

    // Layer 5: 48h hold timers → Claude review
    await checkHoldTimers(livePositions, regime).catch(e =>
      console.error("[cronScanner] holdTimers:", e)
    );

    const outcomes: SignalOutcome[] = [];

    // Crypto-only signals
    const cryptoOpps = result.opportunities.filter(o => !EQUITY_CLASSES.has(o.assetClass ?? ""));

    // Position review for existing positions
    const posReview = await makePositionReview(cryptoOpps, livePositions, bybitBalance);
    for (const posDecision of posReview.positions) {
      await handlePositionDecision(posDecision, livePositions, bybitBalance, outcomes, cryptoOpps).catch(e =>
        console.error(`[cronScanner] posDecision ${posDecision.symbol}:`, e)
      );
    }

    // Layer 2: Apply hard filters to new signals
    const existingSyms  = new Set(livePositions.map(p => bybitSym(p.symbol)));

    // Log all signals received from Claude for diagnostics
    console.log(`[cronScanner] Signals from Claude: ${cryptoOpps.map(o => `${o.symbol}(score=${o.score},dir=${o.direction ?? "?"},conv=${o.conviction ?? "?"}`).join(", ")}`);

    // Pre-filter: skip already-held symbols — no regime score gate, Claude decides freely
    const execThreshold = getRegimeThreshold(regime?.regime); // kept for watchlist display only
    const preRejected: Array<{ symbol: string; reason: string }> = [];
    const newSignals = cryptoOpps.filter(o => {
      if (existingSyms.has(bybitSym(o.symbol))) return false; // already in position
      return true;
    });

    const { passed: filteredSignals, rejected: hardRejected } = await applyHardFilters(newSignals, regime);
    const rejected = [...preRejected, ...hardRejected];

    if (rejected.length) {
      console.log(`[cronScanner] Filtered out: ${rejected.map(r => `${r.symbol}(${r.reason})`).join(", ")}`);
    }

    // Rank by score; balance < $5 is the only hard stop
    if (bybitBalance < 5) {
      console.log(`[cronScanner] Balance $${bybitBalance.toFixed(2)} < $5 — skipping new entries`);
    }
    const rankedSignals = bybitBalance < 5 ? [] : filteredSignals
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, MAX_AUTO_TRADES);

    // ── Position limit: max 3 open — capital preservation (live check) ────
    const MAX_OPEN_POSITIONS = 3;
    const liveForLimit = await bybitGetPositions().catch(() => [] as BybitPosition[]);
    const openCountNow = liveForLimit.length;
    if (openCountNow >= MAX_OPEN_POSITIONS) {
      console.log(`[cronScanner] Position limit: ${openCountNow}/${MAX_OPEN_POSITIONS} positions open — skipping new entries`);
    }
    let openedThisScan = 0;

    for (const opp of rankedSignals) {
      // Position limit guard — recheck each iteration in case we opened one this scan
      if (openCountNow + openedThisScan >= MAX_OPEN_POSITIONS) {
        console.log(`[cronScanner] Position limit reached (${openCountNow + openedThisScan}/${MAX_OPEN_POSITIONS}) — no more entries this scan`);
        break;
      }
      if (await isCoinSuspended(opp.symbol)) continue;
      const sym = bybitSym(opp.symbol);

      // Hard gate — SL/TP/setupType/score required before any order
      {
        const gateRequired: Record<string, unknown> = {
          stopLoss:  opp.stopLoss,
          tp1:       opp.tp1,
          setupType: opp.setupType,
          score:     opp.score,
        };
        const gateMissing = Object.entries(gateRequired)
          .filter(([, v]) => typeof v === 'number' ? v <= 0 : !v)
          .map(([k]) => k);
        if (gateMissing.length > 0) {
          console.log(`[gate] REJECTED ${sym} — missing required fields: ${gateMissing.join(", ")}`);
          alertFn?.([
            `🚫 Entry rejected — ${sym}`,
            `Missing: ${gateMissing.join(", ")}`,
            `No trade without SL/TP/setup type.`,
          ].join("\n")).catch(() => {});
          continue;
        }
      }

      // R:R gate — blended reward across both exits (more reliable than Claude's reported field)
      {
        const rrEntry  = opp.entry ?? opp.price;
        const riskDist = Math.abs(rrEntry - (opp.stopLoss ?? 0));
        const tp1Frac  = (opp.tp1ClosePercent ?? 30) / 100;
        const tp2Frac  = (1 - tp1Frac) * (opp.tp2ClosePercent ?? 100) / 100;
        const rewardDist = tp1Frac * Math.abs((opp.tp1 ?? 0) - rrEntry)
                         + tp2Frac * Math.abs((opp.tp2 ?? 0) - rrEntry);
        const rrRatio  = riskDist > 0 ? rewardDist / riskDist : 0;
        if (rrRatio < 1.1) {
          console.log(`[gate] REJECTED ${sym} — R:R ${rrRatio.toFixed(2)} < 1.1`);
          alertFn?.([
            `🚫 Entry rejected — ${sym}`,
            `Reward:Risk ${rrRatio.toFixed(2)} below minimum 1.1`,
          ].join("\n")).catch(() => {});
          continue;
        }
      }

      // Layer 4+5: R-multiple sizing
      const amountUsd = calcRMultipleSizing(
        bybitBalance,
        opp.entry     ?? opp.price,
        opp.stopLoss  ?? 0,
        opp.leverage  ?? 10,
        opp.score     ?? 65,
        opp.conflictResolution ?? "NO_CONFLICT",
        opp.timing             ?? "EARLY",
        opp.setupQuality       ?? "MEDIUM",
      );
      if (amountUsd <= 0) continue; // skip MAJOR_SKIP or zero-size

      const proposal = buildProposal({
        symbol:          sym,
        side:            opp.direction === "short" ? "sell" : "buy",
        amountUsd,
        assetClass:      opp.assetClass,
        broker:          "bybit",
        rationale:       `[Cron] ${opp.direction === "short" ? ((opp.score ?? 0) >= 80 ? "STRONG SELL" : "SELL") : opp.recommendation} score=${opp.score} regime=${regime?.regime ?? "?"}. ${opp.reasoning ?? ""}`,
        score:           opp.score,
        currentPrice:    opp.price,
        dataTimestamp:   opp.dataTimestamp,
        stopLossPrice:    opp.stopLoss,
        takeProfitPrice:  opp.tp2 ?? opp.takeProfit,
        tp1Price:         opp.tp1,
        limitPrice:       opp.limitPrice ?? opp.entry,
        tp1ClosePercent:  opp.tp1ClosePercent,
        tp2ClosePercent:  opp.tp2ClosePercent,
      });
      const gateResult = await approvalGate.submit(proposal).catch(e => {
        console.error(`[cronScanner] submit ${sym}:`, e);
        return { action: "failed" as const, proposal, message: String(e), orderId: undefined };
      });

      if (gateResult.action === "executed") {
        openedThisScan++; // track toward position limit
        patchEntrySource(sym, "auto_scan").catch(e => console.warn(`[cronScanner] patchEntrySource ${sym}:`, e.message));
        patchPositionMeta(sym, { score: opp.score ?? 0 }).catch(() => {});

        // Verify metadata completeness — atr excluded: startup stores atr=0 for Claude SL/TP
        setTimeout(async () => {
          const s2   = await loadBotState().catch(() => null);
          const pm   = ((s2?.positionMetadata ?? {}) as Record<string, PositionMeta>)[sym];
          const required: (keyof PositionMeta)[] = ["tp1", "sl", "originalQty"];
          const missing = required.filter(f => !pm?.[f as keyof PositionMeta]);
          if (missing.length > 0) {
            console.log(`[cronScanner] ⚠️ Missing metadata for ${sym}: ${missing.join(", ")} — applying ATR fallback`);
            const liveAfterCheck = await bybitGetPositions().catch(() => [] as BybitPosition[]);
            const pos2           = liveAfterCheck.find(p => p.symbol === sym);
            if (pos2) {
              const dir = pos2.side === "Buy" ? "long" : "short" as "long" | "short";
              await applyAtrSlTp(sym, dir, pos2.entryPrice, pos2.positionIdx, pos2.size)
                .catch(e => console.warn(`[cronScanner] applyAtrSlTp fallback ${sym}:`, (e as Error).message));
            }
          }
        }, 5000);

        // Verify actual direction from live Bybit position — signal direction can differ from what Bybit opened
        const signalDirection = opp.direction === "short" ? "short" : "long";
        let actualDirection: "long" | "short" = signalDirection;
        let livePos: BybitPosition | undefined;
        try {
          const liveAfterOpen = await bybitGetPositions();
          livePos = liveAfterOpen.find(p => p.symbol === sym);
          if (livePos) {
            actualDirection = livePos.side === "Buy" ? "long" : "short";
            if (actualDirection !== signalDirection) {
              console.warn(`[cronScanner] ⚠️ Direction mismatch: signal=${signalDirection} but Bybit side=${livePos.side} — using Bybit as truth`);
            }
          }
        } catch { /* non-fatal — fall back to signal direction */ }

        // Use actual deployed margin from live position (market orders fill immediately);
        // limit orders: livePos is undefined here, defer amountUsd reconcile to posMonitor fill
        const deployedMargin = livePos
          ? livePos.size * livePos.entryPrice / livePos.leverage
          : amountUsd;

        // Guard: prevent phantom trade_log rows on silent entry failure.
        // Market orders require a live Bybit position. Limit orders require the orderId on Bybit.
        if (!livePos) {
          if (pendingLimitFills.has(sym)) {
            const openOrders = await bybitGetOrders().catch(() => [] as Awaited<ReturnType<typeof bybitGetOrders>>);
            const orderOnBybit = openOrders.find(o => o.orderId === gateResult.orderId && o.symbol === sym);
            if (!orderOnBybit) {
              pendingLimitFills.delete(sym);
              console.warn(`[cronScanner] ⚠️ Silent entry failure ${sym}: limit orderId not found on Bybit — skipping logOpenTrade`);
              await alertFn?.([`⚠️ SILENT ENTRY FAIL: ${sym} limit order — not on Bybit. NOT logged.`]).catch(() => {});
              continue;
            }
            console.log(`[cronScanner] ${sym} limit order confirmed on Bybit (orderId: ${gateResult.orderId ?? "?"})`);
          } else {
            console.warn(`[cronScanner] ⚠️ Silent entry failure ${sym}: no position after market order — skipping logOpenTrade`);
            await alertFn?.([`⚠️ SILENT ENTRY FAIL: ${sym} — no Bybit position. NOT logged.`]).catch(() => {});
            continue;
          }
        }

        // Log to trade memory so history page and future reviews have entry context
        const newTradeId = await logOpenTrade({
          symbol:          sym,
          broker:          "bybit",
          direction:       actualDirection,
          entryPrice:      opp.entry ?? opp.price,
          leverage:        opp.leverage ?? 10,
          amountUsd:       deployedMargin,
          reasoning:       `[Cron] score=${opp.score} regime=${regime?.regime ?? "?"} setup=${opp.setupType ?? "?"} whyNow=${opp.whyNow ?? opp.reasoning?.slice(0, 200) ?? ""}`,
          stopLoss:        opp.stopLoss,
          takeProfit:      opp.takeProfit,
          stopLossMethod:  opp.stopLossMethod,
        }).catch(e => { console.warn(`[cronScanner] logOpenTrade ${sym}:`, e.message); return null; });

        // Selective rule tagging — only tag a rule if it genuinely applied to this trade.
        // Matching on ruleNumber (stable across regens) not on PK id.
        // Per-symbol regime from opp.symRegime (NOT BTC proxy regime) for regime-gated rules.
        //
        // getActiveRules() returns only WHERE active=true — inactive rules are never in this
        // list and therefore can never be tagged regardless of their ruleNumber.
        // If a rule is later reactivated it accumulates attribution only from that point
        // forward; trades entered while it was inactive carry no retroactive tag for it.
        const symReg  = opp.symRegime;
        const setup   = (opp.setupType ?? "").toUpperCase();
        const score   = opp.score ?? 0;
        const isShort = actualDirection === "short";

        const activeRulesForTag = await getActiveRules().catch(() => [] as Awaited<ReturnType<typeof getActiveRules>>);
        const appliedRuleIds = activeRulesForTag
          .filter(r => {
            switch (r.ruleNumber) {
              // Rule 1: HARD VETO (code-enforced downtrend gate) — veto trades are invisible,
              // tagging passing trades measures global win rate not the rule. Skip.
              case 1:  return false;

              // Universal rules — apply to every executed trade
              case 2:  return true;   // pre-entry checklist: SL/TP1/TP2 required
              case 3:  return true;   // TP1 calibration by regime
              case 4:  return true;   // entry candle direction filter (condition not detectable at tag time)
              case 6:  return true;   // SL width by regime
              case 7:  return true;   // TP execution verification
              case 8:  return true;   // no partial closes below entry
              case 12: return true;   // move SL to breakeven after TP1
              case 15: return true;   // adverse entry candle SL placement (condition not detectable at tag time)

              // Directional: short trades only
              case 5:  return isShort;   // RS leadership veto on shorts
              case 10: return isShort;   // volume climax exhaustion filter for shorts

              // Regime-gated: per-symbol regime (not BTC proxy)
              case 9:  return symReg === "STRONG_TREND" && setup.includes("MOMENTUM") && score >= 78;
              case 11: return symReg === "CHOPPY";
              case 14: return symReg === "RANGING" || symReg === "EXHAUSTION";

              // Rule 13: Version B premium limit — VB data unavailable at tag time. Skip.
              case 13: return false;

              // Unknown future rules: tag all by default (safe fallback)
              default: return true;
            }
          })
          .map(r => r.id);
        console.log(`[rules] Tagged ${sym} dir=${actualDirection} regime=${symReg ?? "?"} setup=${setup} score=${score} → rule IDs: [${appliedRuleIds.join(", ")}]`);

        // Patch trade_log row with signal TP1/TP2/SL for durable partial-exit tracking
        // Also reconcile entryPrice and leverage from actual Bybit fill (livePos already fetched above)
        if (livePos) {
          const plannedEntry = opp.entry ?? opp.price;
          console.log(`[trade] Entry price reconciled ${sym}: planned $${plannedEntry} → actual $${livePos.entryPrice} | leverage: ${opp.leverage ?? 10}× → ${livePos.leverage}×`);
        }
        await db.update(tradeLogTable)
          .set({
            tp1:              opp.tp1      ? String(opp.tp1)      : null,
            tp2:              opp.tp2      ? String(opp.tp2)      : null,
            sl:               opp.stopLoss ? String(opp.stopLoss) : null,
            atr:              opp.atr      ? String(opp.atr)      : null,
            setupType:        opp.setupType ?? null,
            score:            opp.score    ? String(opp.score)    : null,
            whyNow:           opp.whyNow   ?? null,
            appliedRuleIds:   appliedRuleIds.length ? appliedRuleIds : null,
            blowoffSuspected: opp.blowoffSuspected ? "1" : null,
            ...(livePos ? { entryPrice: String(livePos.entryPrice), leverage: livePos.leverage } : {}),
          })
          .where(newTradeId
            ? eq(tradeLogTable.id, newTradeId)
            : and(eq(tradeLogTable.symbol, sym), isNull(tradeLogTable.exitAt)))
          .catch(e => console.warn(`[cronScanner] trade_log tp patch ${sym}:`, e.message));

        const rMult = (opp.score ?? 65) >= 90 ? 1.2 : (opp.score ?? 65) >= 75 ? 1.0 : 0.5;
        const entryLines = [
          `✅ <b>NEW ENTRY — ${sym} ${(opp.direction ?? "?").toUpperCase()}</b>`,
          ``,
          `📊 Setup: ${opp.setupType ?? "?"} (${opp.setupQuality ?? "?"} quality)`,
          `⏰ Timing: ${opp.timing ?? "?"}`,
          `🎯 Edge: ${escapeHtml(opp.whyNow ?? opp.reasoning?.slice(0, 120) ?? "?")}`,
          opp.relativeStrengthVsBtc != null && opp.relativeStrengthVsBtc !== 0
            ? `📉 vs BTC: ${opp.relativeStrengthVsBtc > 0 ? "+" : ""}${(opp.relativeStrengthVsBtc as number).toFixed(1)}%`
            : null,
          opp.squeezeDetected ? `💰 Squeeze setup detected` : null,
          opp.blowoffSuspected ? `⚠️ BLOWOFF_SUSPECTED at entry — 4h exhaustion pattern present` : null,
          (opp.conflicts as string[] | undefined)?.length
            ? `⚔️ Conflicts: ${escapeHtml((opp.conflicts as string[]).join("; "))}`
            : `⚔️ Conflicts: none`,
          ``,
          `Entry: ${opp.orderType === "limit" ? `limit $${opp.limitPrice ?? opp.entry ?? "?"}` : "market"} | Score: ${opp.score} → ${rMult}R`,
          `SL: $${opp.stopLoss?.toFixed(4) ?? "?"} | TP1: $${opp.tp1?.toFixed(4) ?? "?"} | TP2: $${opp.tp2?.toFixed(4) ?? "?"}`,
          `Risk: $${(bybitBalance * 0.05 * rMult).toFixed(2)} | Size: $${amountUsd.toFixed(0)} (${opp.leverage ?? 10}×)`,
          opp.rewardRiskRatio ? `R:R 1:${opp.rewardRiskRatio.toFixed(1)}` : null,
        ].filter(Boolean).join("\n");
        await alertFn?.(entryLines).catch(e => console.error("[telegram] Send failed:", (e as Error).message));
      }

      outcomes.push({
        symbol: sym, amount: amountUsd,
        action: gateResult.action === "executed" ? "NEW" : "HOLD",
        reason: gateResult.message,
      });
    }

    // Telegram summary
    const dailyPnl = await getDailyPnl().catch(() => 0);
    const summary  = formatScanSummary(outcomes, result.opportunities.length, regime, rejected, dailyPnl, bybitBalance, livePositions.length, filteredSignals.length, result.opportunities);
    console.log('[telegram] Sending scan summary...');
    await alertFn?.(summary).catch(e => console.error("[telegram] Send failed:", (e as Error).message));

    // Merge new WATCH-recommendation coins into the watch list (don't overwrite existing watches)
    const newWatchCoins: WatchCoin[] = cryptoOpps
      .filter(o => {
        const dir = o.direction ?? "neutral";
        return (
          o.recommendation === "WATCH" &&
          dir !== "neutral" &&
          !existingSyms.has(bybitSym(o.symbol))
        );
      })
      .map(o => ({
        symbol:    bybitSym(o.symbol),
        direction: o.direction ?? "neutral",
        score:     o.score ?? 0,
        addedAt:   new Date().toISOString(),
      }));

    // Load existing watch list and merge: update score for existing coins, add new ones.
    // Remove any coin that is now in position (existingSyms) or scored in this scan below 55.
    const prevWatch = (await loadBotState().catch(() => null))?.watchList ?? [] as WatchCoin[];
    const scanScores = new Map(cryptoOpps.map(o => [bybitSym(o.symbol), o.score ?? 0]));
    const mergedWatch: WatchCoin[] = [
      // Keep previous watches not in this scan OR still near-threshold in this scan
      ...prevWatch.filter(w => {
        if (existingSyms.has(w.symbol)) return false; // now in position
        const freshScore = scanScores.get(w.symbol);
        if (freshScore !== undefined && freshScore < 55) return false; // setup invalidated
        return true; // keep watching (not in this scan's top-10, or still ok)
      }).map(w => {
        const freshScore = scanScores.get(w.symbol);
        return freshScore !== undefined ? { ...w, score: freshScore } : w; // update score if rescanned
      }),
      // Add newly near-threshold coins not already in the list
      ...newWatchCoins.filter(nw => !prevWatch.some(pw => pw.symbol === nw.symbol)),
    ];

    await saveBotState({ watchList: mergedWatch, watchListUpdatedAt: new Date() }).catch(() => {});

    const addedSyms = newWatchCoins.filter(nw => !prevWatch.some(pw => pw.symbol === nw.symbol));
    if (addedSyms.length) {
      console.log(`[watchScan] ${addedSyms.length} coins added to watch list: ${addedSyms.map(w => w.symbol).join(", ")}`);
    }
    if (mergedWatch.length) {
      const watchMsg = [
        `👀 <b>Watch list (${mergedWatch.length} coins):</b>`,
        ...mergedWatch.map(w => `  • ${w.symbol} ${w.direction.toUpperCase()} — score ${w.score}`),
        `Rescanning every 30 min...`,
      ].join("\n");
      await alertFn?.(watchMsg).catch(e => console.error("[telegram] Send failed:", (e as Error).message));
      startWatchScan();
    }

    console.log(`[cronScanner] Complete — ${result.opportunities.length} signals, ${filteredSignals.length} passed filters, ${rankedSignals.length} actioned`);

    // Version B paper — only when enabled
    if (process.env["PAPER_TRADING_ENABLED"] !== "false") {
      runPaperScan().catch(err => console.error("[paperScanner] Error:", err));
    } else {
      console.log("[paperScanner] Version B disabled via PAPER_TRADING_ENABLED=false");
    }

    // Mode 3 paper — gated by MODE3_PAPER_ENABLED env var (default on)
    if (process.env["MODE3_PAPER_ENABLED"] !== "false") {
      runMode3PaperScan(filteredSignals, regime?.regime ?? "CHOPPY")
        .catch(err => console.error("[mode3Paper] Error:", err));
    } else {
      console.log("[mode3Paper] Disabled via MODE3_PAPER_ENABLED=false");
    }
  } catch (err) {
    console.error("[cronScanner] Scan failed:", err);
  } finally {
    isScanning = false;
  }
}

// ── Position monitor (10-min) ─────────────────────────────────────────────────
const MONITOR_INTERVAL_MS = 10 * 60 * 1000;

// In-memory cache: survives DB failures within a single server session.
// Seeded from DB on first successful read; DB is the write-through target.
const monitorStateCache: Record<string, PositionMonitorState> = {};
// Track last time an ADJUST_SL notification was sent per symbol (to avoid spam)
const lastAdjustSlNotifyAt: Record<string, number> = {};
const ADJUST_SL_NOTIFY_COOLDOWN_MS = 2 * 3_600_000; // at most once per 2h per position
// Symbols that had open positions on the previous monitor tick (for close detection)
const prevPositionSymbols = new Set<string>();
const selfHealAttempted   = new Set<string>(); // prevent repeated ATR fallback per session
let monitorRunning      = false;
let monitorFirstRun     = true; // seed prevPositionSymbols on first tick
let partialExitRunning  = false;

async function checkPositionMonitor(): Promise<void> {
  if (monitorRunning) { console.log("[posMonitor] Previous check still running — skipping tick"); return; }
  monitorRunning = true;
  try {
  const positions = await bybitGetPositions().catch(() => [] as BybitPosition[]);

  // First tick after (re)start: seed prevPositionSymbols from live positions and skip
  // disappearance detection — startup reconciliation handles already-closed positions
  if (monitorFirstRun) {
    monitorFirstRun = false;
    positions.forEach(p => prevPositionSymbols.add(p.symbol));
    console.log(`[posMonitor] First tick — seeded ${prevPositionSymbols.size} symbols: ${[...prevPositionSymbols].join(", ") || "none"}`);
    if (!positions.length) return;
  }

  // Use in-memory cache for all bot_state reads — no DB call per tick
  const stateRow = await loadBotState().catch(() => null);

  if (stateRow?.positionMonitorState) {
    for (const [sym, s] of Object.entries(stateRow.positionMonitorState)) {
      if (!monitorStateCache[sym]) monitorStateCache[sym] = s;
    }
  }

  const monitorState        = monitorStateCache;
  const monitorStateBefore  = JSON.stringify(monitorState);
  const posMeta             = (stateRow?.positionMetadata ?? {}) as Record<string, PositionMeta>;
  const now          = Date.now();

  // ── Position disappearance detection (SL/TP/liquidation) ───────────────────
  // Runs BEFORE the positions.length guard: symbols that vanished during a transient
  // Bybit [] response are still detected and closeOpenTrade is called correctly.
  const prevSymbols    = new Set(prevPositionSymbols); // snapshot for limit-fill detection below
  const currentSymbols = new Set(positions.map(p => p.symbol));
  for (const sym of prevPositionSymbols) {
    if (!currentSymbols.has(sym)) {
      await clearPositionMeta(sym).catch(() => {});
      await removePendingLimitFill(sym).catch(() => {});
      selfHealAttempted.delete(sym);
      // Always fetch closed PnL and close trade_log — regardless of trailing state
      // Group close records by avgEntryPrice proximity + time window. Bybit's closed-pnl endpoint
      // has no position ID; avgEntryPrice is consistent across all partials of one position.
      // Known limit: re-opening the same symbol at a similar price within 4h could merge two trades.
      // Use positionMetadata for entry anchor; fall back to DB if meta missing (avoids unbounded fetch)
      const meta    = posMeta[sym];
      let entryPx      = meta?.entryPrice ?? 0;
      let startMs      = meta?.openedAt ? Math.max(0, meta.openedAt - 4 * 60 * 60 * 1000) : undefined;
      let entryAtDate: Date | undefined = meta?.openedAt ? new Date(meta.openedAt) : undefined;
      if (entryPx <= 0 || startMs === undefined) {
        // Meta incomplete — look up open trade from DB to get a safe time/price anchor
        const [dbTrade] = await db.select({ entryPrice: tradeLogTable.entryPrice, entryAt: tradeLogTable.entryAt })
          .from(tradeLogTable)
          .where(and(eq(tradeLogTable.symbol, sym), eq(tradeLogTable.broker, "bybit"), isNull(tradeLogTable.exitAt)))
          .orderBy(desc(tradeLogTable.entryAt))
          .limit(1)
          .catch(() => []);
        if (dbTrade) {
          if (entryPx <= 0)      entryPx = parseFloat(dbTrade.entryPrice ?? "0");
          if (startMs === undefined && dbTrade.entryAt)
            startMs = Math.max(0, dbTrade.entryAt.getTime() - 4 * 60 * 60 * 1000);
          if (!entryAtDate && dbTrade.entryAt) entryAtDate = dbTrade.entryAt;
        }
      }
      const closed   = await bybitGetClosedPnl(50, startMs, sym).catch(() => []);
      const matching = closed
        .filter(c => entryPx <= 0 || Math.abs(c.avgEntryPrice / entryPx - 1) < 0.06)
        .sort((a, b) => a.closedAt - b.closedAt);
      const totalPnl = matching.reduce((s, c) => s + c.closedPnl, 0);
      const trade    = matching[matching.length - 1]; // final close = exit price
      if (trade && matching.length > 0) {
        const totalAmt   = matching.reduce((s, c) => s + c.closedSize * c.avgEntryPrice, 0);
        const exitReason = await resolveExitReason({
          symbol:  sym,
          orderId: trade.orderId,
          entryAt: entryAtDate,
          exitAt:  new Date(),
        }).catch(() => undefined);
        console.log(`[posMonitor] ${sym} exit reason resolved: ${exitReason ?? "unknown"}`);
        await closeOpenTrade({
          symbol:             sym,
          broker:             "bybit",
          exitPrice:          trade.avgExitPrice,
          amountUsd:          totalAmt,
          pnlOverride:        totalPnl,
          entryPriceOverride: trade.avgEntryPrice,
          exitReason,
        }).catch(e => console.warn(`[posMonitor] closeOpenTrade ${sym}:`, (e as Error).message));
        const won = totalPnl >= 0;
        await alertFn?.([
          `${won ? "✅" : "🔴"} <b>Position closed — ${sym}</b>`,
          `Exit: $${trade.avgExitPrice.toFixed(4)} | P/L: ${won ? "+" : ""}$${totalPnl.toFixed(2)}`,
        ].join("\n")).catch(() => {});
      } else {
        console.warn(`[posMonitor] ${sym} disappeared from positions but no closedPnl record found`);
      }
    }
  }
  // Update prevPositionSymbols before early return so it's current on the next tick
  prevPositionSymbols.clear();
  positions.forEach(p => prevPositionSymbols.add(p.symbol));

  // Skip per-position monitoring when Bybit returned no positions (transient or genuinely flat)
  if (!positions.length) return;

  // ── Limit order fill detection ────────────────────────────────────────────
  // Detect symbols that just appeared as positions (limit order filled since last tick).
  // Apply deferred SL/TP/metadata now that the position exists on Bybit.
  for (const pos of positions) {
    if (!prevSymbols.has(pos.symbol) && pendingLimitFills.has(pos.symbol)) {
      const pending = pendingLimitFills.get(pos.symbol)!;
      await removePendingLimitFill(pos.symbol).catch(() => {});
      console.log(`[posMonitor] Limit filled — ${pos.symbol} at $${pos.entryPrice.toFixed(4)}`);
      await patchPositionMeta(pos.symbol, {
        sl:              pending.sl,
        tp1:             pending.tp1,
        tp2:             pending.tp2,
        originalQty:     pos.size,
        entryPrice:      pos.entryPrice,
        openedAt:        Date.now(),
        tp1ClosePercent: pending.tp1ClosePercent,
        tp2ClosePercent: pending.tp2ClosePercent,
      }).catch(() => {});
      if (pending.tp1 && pending.tp1 > 0) {
        await bybitSetTp1Partial(pos.symbol, pending.tp1, pos.positionIdx, pos.size, pending.tp1ClosePercent)
          .catch(e => console.warn(`[posMonitor] TP1 on fill ${pos.symbol}:`, (e as Error).message));
      }
      if (pending.tp2 && pending.tp2 > 0 && (pending.tp2ClosePercent ?? 100) < 100) {
        await bybitSetTp2Partial(pos.symbol, pending.tp2, pos.positionIdx, pos.size, pending.tp2ClosePercent)
          .catch(e => console.warn(`[posMonitor] TP2 on fill ${pos.symbol}:`, (e as Error).message));
      }
      await alertFn?.([
        `✅ <b>Limit filled — ${pos.symbol} ${pending.direction.toUpperCase()}</b>`,
        `Entry: $${pos.entryPrice.toFixed(4)}`,
        pending.sl  ? `SL:  $${pending.sl.toFixed(4)}`  : null,
        pending.tp1 ? `TP1: $${pending.tp1.toFixed(4)}` : null,
        pending.tp2 ? `TP2: $${pending.tp2.toFixed(4)}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    }
  }

  for (const pos of positions) {
    const pnlPct = pos.pnlPct ?? 0;
    const state  = monitorState[pos.symbol] ?? { lastReviewAt: 0, lastFundingRate: 0, lastOI: 0, lastRSI1h: 0 };

    // Track peak unrealized P/L — write only when a new high is reached
    const existingPeak = (posMeta[pos.symbol]?.peakPnlPct ?? -Infinity);
    if (pnlPct > existingPeak) {
      await patchPositionMeta(pos.symbol, { peakPnlPct: pnlPct }).catch(() => {});
    }

    // ── Self-healing metadata check (runs every tick until fixed) ─────────────
    const selfMeta = posMeta[pos.symbol];
    const selfRequired: (keyof PositionMeta)[] = ["tp1", "sl", "originalQty"];
    const selfMissing = selfRequired.filter(f => !selfMeta?.[f as keyof PositionMeta]);
    if (selfMissing.length > 0 && !selfHealAttempted.has(pos.symbol)) {
      selfHealAttempted.add(pos.symbol);
      console.log(`[posMonitor] ⚠️ ${pos.symbol} missing: ${selfMissing.join(",")} — self-healing`);
      const healDir = pos.side === "Buy" ? "long" : "short" as "long" | "short";
      applyAtrSlTp(pos.symbol, healDir, pos.entryPrice, pos.positionIdx, pos.size)
        .then(() => { _botStateCache = null; }) // clear cache so next tick picks up healed metadata
        .catch(e => console.warn(`[posMonitor] self-heal ${pos.symbol}:`, (e as Error).message));
    }

    // ── Large profit exits (no Claude needed — zero cost) ─────────────────────
    if (pnlPct >= LARGE_PROFIT_CLOSE_PCT) {
      console.log(`[posMonitor] ${pos.symbol} large profit +${pnlPct.toFixed(1)}% ≥ ${LARGE_PROFIT_CLOSE_PCT}% → closing full position`);
      await bybitClose(pos.symbol).catch(e => console.error(`[posMonitor] largeProfit close ${pos.symbol}:`, e.message));
      const lpFill = await fetchActualFillPrice(pos.symbol, pos.entryPrice, pos.markPrice ?? pos.entryPrice);
      await closeOpenTrade({ symbol: pos.symbol, broker: "bybit", exitPrice: lpFill, amountUsd: pos.size * pos.entryPrice, entryPriceOverride: pos.entryPrice, directionOverride: pos.side === "Buy" ? "long" : "short", exitReason: "profit_protection" }).catch(() => {});
      await clearPositionMeta(pos.symbol).catch(() => {});
      await alertFn?.([
        `💰 <b>Large profit exit — ${pos.symbol}</b>`,
        `P/L: <b>+${pnlPct.toFixed(1)}%</b> (≥${LARGE_PROFIT_CLOSE_PCT}% threshold)`,
        `Closing full position to lock gains`,
      ].join("\n")).catch(() => {});
      continue;
    }
    if (pnlPct >= LARGE_PROFIT_PARTIAL_PCT) {
      console.log(`[posMonitor] ${pos.symbol} large profit +${pnlPct.toFixed(1)}% ≥ ${LARGE_PROFIT_PARTIAL_PCT}% → closing 50%, activating trailing SL`);
      await closePercentPosition(pos.symbol, 50).catch(e => console.error(`[posMonitor] largeProfit partial ${pos.symbol}:`, e.message));
      await setTrailingStop(pos.symbol, 0.40).catch(() => {});
      await patchPositionMeta(pos.symbol, { trailingActive: true }).catch(() => {});
      await alertFn?.([
        `💰 <b>Partial profit lock — ${pos.symbol}</b>`,
        `P/L: <b>+${pnlPct.toFixed(1)}%</b> (≥${LARGE_PROFIT_PARTIAL_PCT}% threshold)`,
        `Closed 50% to secure gains`,
        `Remaining 50% with 40% trailing SL activated`,
      ].join("\n")).catch(() => {});
      logPartialClose({ symbol: pos.symbol, partialType: "large_profit", closePct: 50, priceAtClose: pos.markPrice ?? pos.entryPrice, pnlPct, remainingPct: 50 }).catch(() => {});
      continue;
    }

    // Hard stop: -40%
    if (pnlPct <= -40) {
      console.warn(`[posMonitor] ${pos.symbol} hit -40% hard stop — closing`);
      const closeSide = pos.side === "Buy" ? "Sell" as const : "Buy" as const;
      await bybitClose(pos.symbol).catch(e =>
        console.error(`[posMonitor] close ${pos.symbol}:`, (e as Error).message)
      );
      const hsFill = await fetchActualFillPrice(pos.symbol, pos.entryPrice, pos.markPrice ?? pos.entryPrice);
      await closeOpenTrade({ symbol: pos.symbol, broker: "bybit", exitPrice: hsFill, amountUsd: pos.size * pos.entryPrice, entryPriceOverride: pos.entryPrice, directionOverride: pos.side === "Buy" ? "long" : "short", exitReason: "sl_hit" }).catch(() => {});
      await clearPositionMeta(pos.symbol).catch(() => {});
      await alertFn?.(`🛑 <b>Hard stop — ${pos.symbol}</b>\nP/L: ${pnlPct.toFixed(1)}% hit -40% limit. Position closed.`).catch(e => console.error("[telegram] Send failed:", (e as Error).message));
      void closeSide; // suppress unused variable warning
      continue;
    }

    // Mechanical breakeven: when P/L ≥ +2% and SL is still below entry (longs) or above entry (shorts),
    // move SL to entry. Self-gating — fires once, then the condition is never true again.
    if (pnlPct >= 2 && pos.entryPrice > 0) {
      const beSlRaw = posMeta[pos.symbol]?.sl ?? pos.stopLoss ?? 0;
      const beSl    = typeof beSlRaw === "number" ? beSlRaw : parseFloat(String(beSlRaw) || "0");
      const isLong  = pos.side === "Buy";
      const needsBe = beSl > 0 && (isLong ? beSl < pos.entryPrice : beSl > pos.entryPrice);
      if (needsBe) {
        await bybitSetStopLoss(pos.symbol, pos.entryPrice, pos.positionIdx)
          .catch(e => console.warn(`[posMonitor] Breakeven SL failed ${pos.symbol}:`, (e as Error).message));
        await patchPositionMeta(pos.symbol, { sl: pos.entryPrice }).catch(() => {});
        db.update(tradeLogTable).set({ effectiveSl: String(pos.entryPrice) })
          .where(and(eq(tradeLogTable.symbol, pos.symbol), isNull(tradeLogTable.exitAt))).catch(() => {});
        console.log(`[posMonitor] ${pos.symbol} SL → breakeven $${pos.entryPrice.toFixed(4)} (P/L ${pnlPct.toFixed(1)}% ≥ +2%)`);
        await alertFn?.(`🛡️ <b>Breakeven SL — ${pos.symbol}</b>\nP/L +${pnlPct.toFixed(1)}% → SL moved to entry $${pos.entryPrice.toFixed(4)}`).catch(() => {});
      }
    }

    // Review interval by P/L tier
    const intervalMs =
      pnlPct <= -20 ? 30 * 60_000  :
      pnlPct <= -10 ? 60 * 60_000  :
      pnlPct <= -5  ? 2  * 3_600_000 :
      pnlPct >= 100 ? 30 * 60_000  :
      pnlPct >= 50  ? 60 * 60_000  :
      pnlPct >= 20  ? 2  * 3_600_000 :
                      4  * 3_600_000;

    // Fetch fresh data for trigger checks
    const [frRes, klRes, oiRes, kl4hRes] = await Promise.allSettled([
      getFundingRate(pos.symbol),
      getKlines(pos.symbol, "60", 25),
      getOpenInterest(pos.symbol),
      getKlines(pos.symbol, "240", 28),
    ]);
    const fr       = frRes.status   === "fulfilled" ? frRes.value  : null;
    const klines   = klRes.status   === "fulfilled" ? (klRes.value   as BybitKline[]) : [] as BybitKline[];
    const oiVal    = oiRes.status   === "fulfilled" ? (oiRes.value   as number)       : null;
    const klines4h = kl4hRes.status === "fulfilled" ? (kl4hRes.value as BybitKline[]) : [] as BybitKline[];

    let trigger: string | null = null;

    // Trigger 1: Funding flip — only if magnitude significant (>0.05% change AND >0.05% new rate)
    if (fr && state.lastFundingRate !== 0) {
      const oldPct = state.lastFundingRate * 100;
      const newPct = fr.rate * 100;
      const change = Math.abs(newPct - oldPct);
      const flipped = (state.lastFundingRate > 0 && fr.rate < 0) || (state.lastFundingRate < 0 && fr.rate > 0);
      const significant = change > 0.05 && Math.abs(newPct) > 0.05;
      console.log(`[trigger] ${pos.symbol} funding change: ${change.toFixed(4)}% threshold: 0.05% → ${flipped && significant ? "TRIGGERED" : "ignored"}`);
      if (flipped && significant) trigger = `Funding rate flipped: ${oldPct.toFixed(4)}% → ${newPct.toFixed(4)}%`;
    }

    // Trigger 2: OI drop >20%
    if (!trigger && oiVal != null && state.lastOI > 0) {
      const drop = (state.lastOI - oiVal) / state.lastOI;
      if (drop > 0.20) trigger = `OI dropped ${(drop*100).toFixed(1)}% since last check`;
    }

    // Trigger 3 & 4: RSI cross + volume spike
    if (!trigger && klines.length >= 15) {
      const closes  = klines.map(k => k.close);
      const rsi     = calcRSI(closes, 14);
      if (state.lastRSI1h > 0) {
        if (state.lastRSI1h < 75 && rsi >= 75) trigger = `1h RSI crossed above 75 (${rsi.toFixed(1)}) — overbought`;
        if (state.lastRSI1h > 25 && rsi <= 25) trigger = `1h RSI crossed below 25 (${rsi.toFixed(1)}) — oversold`;
      }
      // Use second-to-last candle (last COMPLETE 1h bar) — avoids re-firing every 5 min
      // on the same in-progress candle
      if (!trigger && klines.length >= 22) {
        const completedCandles = klines.slice(0, -1); // drop the forming candle
        const volAvg = completedCandles.slice(-21, -1).reduce((s, k) => s + k.volume, 0) / 20;
        const lastVol = completedCandles[completedCandles.length - 1]!.volume;
        if (volAvg > 0 && lastVol > volAvg * 5)
          trigger = `Volume spike ${(lastVol/volAvg).toFixed(1)}× on last completed 1h candle`;
      }
      monitorState[pos.symbol] = { ...(monitorState[pos.symbol] ?? state), lastRSI1h: rsi };
    }

    // Update funding/OI state
    if (fr != null)    monitorState[pos.symbol] = { ...(monitorState[pos.symbol] ?? state), lastFundingRate: fr.rate };
    if (oiVal != null) monitorState[pos.symbol] = { ...(monitorState[pos.symbol] ?? state), lastOI: oiVal };

    // Triggers respect a 30-min cooldown — prevents re-firing every tick on a
    // persistent condition (e.g. same high-volume candle, OI still low)
    const timeSinceReview = now - state.lastReviewAt;
    const TRIGGER_COOLDOWN_MS = 30 * 60_000;
    const shouldReview = (trigger !== null && timeSinceReview >= TRIGGER_COOLDOWN_MS) || timeSinceReview >= intervalMs;
    console.log(`[posMonitor] ${pos.symbol} P/L:${pnlPct.toFixed(1)}% lastReviewAt:${state.lastReviewAt === 0 ? "never" : new Date(state.lastReviewAt).toISOString()} sinceLast:${Math.round(timeSinceReview/60000)}min interval:${Math.round(intervalMs/60000)}min trigger:${trigger ?? "none"} → ${shouldReview ? "REVIEW" : "skip"}`);
    if (!shouldReview) continue;

    await runPositionReview(pos, trigger, klines, fr, oiVal, posMeta[pos.symbol], stateRow?.currentRegime ?? null).catch(e =>
      console.error(`[posMonitor] review ${pos.symbol}:`, e)
    );
    monitorState[pos.symbol] = { ...(monitorState[pos.symbol] ?? state), lastReviewAt: now };
  }

  // ── Partial exit tier checks (runs every 5 min, not just on cron scan) ──────
  await checkPartialExits(positions).catch(e =>
    console.error("[posMonitor] partialExits:", e)
  );

  // Persist monitor state only if it changed this tick
  if (JSON.stringify(monitorState) !== monitorStateBefore) {
    if (_botStateCache) _botStateCache = { ..._botStateCache, positionMonitorState: monitorState } as typeof _botStateCache;
    await db.update(botStateTable)
      .set({ positionMonitorState: monitorState, lastUpdated: new Date() })
      .where(eq(botStateTable.id, 1))
      .catch(e => console.warn("[posMonitor] state save:", (e as Error).message));
  }

  } finally {
    monitorRunning = false;
  }
}

async function runPositionReview(
  pos:     BybitPosition,
  trigger: string | null,
  klines:  BybitKline[],
  fr:      { rate: number } | null,
  oi:      number | null,
  meta:    PositionMeta | undefined,
  regime:  string | null,
): Promise<void> {
  const closes = klines.map(k => k.close);
  const ema20  = closes.length >= 20 ? calcEMA(closes, 20) : 0;
  const ema50  = closes.length >= 50 ? calcEMA(closes, 50) : 0;
  const rsi    = closes.length >= 15 ? calcRSI(closes, 14) : 0;
  const heldH  = meta?.openedAt ? ((Date.now() - meta.openedAt) / 3_600_000).toFixed(1) : "?";
  const pnlPct = pos.pnlPct ?? 0;
  const dir    = pos.side === "Buy" ? "LONG" : "SHORT";
  const isLong = dir === "LONG";

  // Use metadata SL/TP if available, fall back to exchange values on position
  const sl  = meta?.sl  ?? pos.stopLoss;
  const tp1 = meta?.tp1 ?? pos.takeProfit;
  const tp2 = meta?.tp2;

  const currentPrice = closes.length > 0 ? (closes[closes.length - 1] ?? pos.entryPrice) : pos.entryPrice;
  const fundingStr   = fr ? `${(fr.rate * 100).toFixed(4)}%` : "unknown";
  const isRanging    = regime?.toUpperCase().includes("RANGING") ?? false;

  // Recent exits for this symbol in last 24h — gives Claude awareness of prior same-symbol losses
  const cutoff24h = new Date(Date.now() - 24 * 3_600_000);
  const recentExit = await db.select({
    exitMethod:   tradeMemoryTable.exitMethod,
    pnlPct:       tradeMemoryTable.pnlPct,
    priceAtClose: tradeMemoryTable.priceAtClose,
    createdAt:    tradeMemoryTable.createdAt,
  }).from(tradeMemoryTable)
    .where(and(
      eq(tradeMemoryTable.symbol, pos.symbol),
      eq(tradeMemoryTable.action, "TRADE_CLOSE"),
      gt(tradeMemoryTable.createdAt, cutoff24h),
    ))
    .orderBy(desc(tradeMemoryTable.createdAt))
    .limit(1)
    .then(r => r[0] ?? null)
    .catch(() => null);

  const priorExitLine = (() => {
    if (!recentExit) return null;
    const hoursAgo  = Math.round((Date.now() - new Date(recentExit.createdAt).getTime()) / 3_600_000);
    const method    = recentExit.exitMethod ?? "exit";
    const pnl       = recentExit.pnlPct ? ` (${parseFloat(recentExit.pnlPct) >= 0 ? "+" : ""}${parseFloat(recentExit.pnlPct).toFixed(2)}%)` : "";
    const price     = recentExit.priceAtClose ? ` at $${recentExit.priceAtClose}` : "";
    return `Prior exit: ${pos.symbol} ${method}${hoursAgo}h ago${price}${pnl}`;
  })();

  // FIX 2: Skip early reviews when trade is still healthy
  const positionAgeHours = meta?.openedAt ? (Date.now() - meta.openedAt) / 3_600_000 : 999;
  const slVal = typeof sl === "number" ? sl : parseFloat(String(sl) || "0");
  const slDistancePct = slVal > 0 && pos.entryPrice > 0
    ? Math.abs((slVal - pos.entryPrice) / pos.entryPrice * 100) : 0;
  const slConsumedPct = slDistancePct > 0 ? Math.abs(pnlPct) / slDistancePct * 100 : 0;
  if (positionAgeHours < 4 && pnlPct > -5 && slConsumedPct < 30) {
    console.log(`[posMonitor] Skipping ${pos.symbol} review — age ${positionAgeHours.toFixed(1)}h, P/L ${pnlPct.toFixed(2)}%, SL consumed ${slConsumedPct.toFixed(0)}% — too early`);
    return;
  }

  // Direction-aware thesis signals
  const thesisCheck = isLong ? [
    `LONG thesis SUPPORTING signals (each one you see adds conviction):`,
    `  • Price above EMA20 and EMA50`,
    `  • RSI below 70 (not overbought)`,
    `  • Funding rate negative or near zero (longs not overcrowded)`,
    `  • OI stable or rising with price (genuine demand)`,
    `  • BTC or broader market green / neutral`,
    `  • Recent candles show higher lows or strong closes`,
    `LONG thesis UNDERMINING signals (each one you see reduces conviction):`,
    `  • Price breaks below EMA20 on high volume`,
    `  • RSI above 70 and rolling over`,
    `  • Funding rate positive and rising (long squeeze risk)`,
    `  • OI dropping while price still up (distribution)`,
    `  • BTC selling off or making lower highs`,
    `  • Large wicks to upside rejected at resistance`,
  ] : [
    `SHORT thesis SUPPORTING signals (each one you see adds conviction):`,
    `  • Price below EMA20 and EMA50`,
    `  • RSI above 30 but declining (not yet oversold)`,
    `  • Funding rate positive (shorts getting paid, longs overcrowded)`,
    `  • OI stable or rising as price falls (genuine selling)`,
    `  • BTC or broader market weak / lower`,
    `  • Recent candles show lower highs or weak closes`,
    `SHORT thesis UNDERMINING signals (each one you see reduces conviction):`,
    `  • Price reclaims EMA20 on strong volume`,
    `  • RSI drops below 30 and bouncing (oversold bounce risk)`,
    `  • Funding rate flips negative (short squeeze risk)`,
    `  • OI dropping as price also drops (short covering rally ahead)`,
    `  • BTC recovering strongly`,
    `  • Breakout candle through recent resistance with volume`,
  ];

  const rangingNote = isRanging
    ? `\nREGIME NOTE — Market is RANGING: treat same as TRENDING. No aggression modifier. Claude decides based on signals only, not regime pressure.`
    : "";

  const prompt = [
    `Position: ${pos.symbol} ${dir} | Entry: $${pos.entryPrice.toFixed(4)} | Current: $${currentPrice.toFixed(4)}`,
    `Held: ${positionAgeHours < 999 ? positionAgeHours.toFixed(1) + "h" : heldH + "h"} | Peak P/L: ${meta?.peakPnlPct != null ? (meta.peakPnlPct >= 0 ? "+" : "") + meta.peakPnlPct.toFixed(2) + "%" : "n/a"} | Current P/L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% | Regime: ${regime ?? "unknown"}`,
    priorExitLine,
    `RSI(14): ${rsi.toFixed(1)} | EMA20: $${ema20.toFixed(4)} | EMA50: $${ema50.toFixed(4)}`,
    `Funding: ${fundingStr}`,
    oi != null ? `OI: ${oi}` : null,
    `SL: ${sl ? "$" + (typeof sl === "number" ? sl.toFixed(4) : sl) : "not set"} | TP1: ${tp1 ? "$" + (typeof tp1 === "number" ? tp1.toFixed(4) : tp1) : "not set"} | TP2: ${tp2 ? "$" + tp2.toFixed(4) : "not set"}`,
    meta?.score != null ? `Original signal score: ${meta.score}/100` : null,
    (meta as any)?.setupType ? `Setup type: ${(meta as any).setupType}${(meta as any).whyNow ? " — " + (meta as any).whyNow : ""}` : null,
    slConsumedPct > 0 ? `SL consumed: ${slConsumedPct.toFixed(0)}% of total SL distance` : null,
    `Bias: if original entry signals are still present, lean HOLD. Only suggest CLOSE/PARTIAL if thesis is completely reversed, loss > -8%, or an opposing signal scores ≥ 80.`,
    trigger ? `\nIMMEDIATE TRIGGER: ${trigger}` : null,
    `\n── CONFIDENCE-BASED DECISION FRAMEWORK ──`,
    ...thesisCheck,
    `\nCount how many supporting vs undermining signals you see for the ${dir} position above.`,
    `Then pick your action based on conviction level:`,
    `  STRONG conviction (supporting clearly outweighs undermining) → HOLD`,
    `  MIXED conviction (roughly even, or 1-2 key signals undermined) → PARTIAL_CLOSE 30%`,
    `  WEAK conviction (undermining outweighs supporting, thesis fading) → PARTIAL_CLOSE 50-70%`,
    `  BROKEN thesis (almost all signals now against position) but at BAD exit spot → ADJUST_SL to nearest key level, let market stop out cleanly`,
    `  BROKEN thesis + loss accelerating with no nearby support/resistance → CLOSE`,
    rangingNote,
    `\nEXIT DISCIPLINE (non-negotiable):`,
    `  • NEVER market-close at support (for shorts) or resistance (for longs) — worst possible exit`,
    `  • ADJUST_SL to a key level first; market will stop you out at a rational price`,
    `  • CLOSE immediately only when: loss is accelerating AND no nearby level to hide behind`,
    `  • PARTIAL_CLOSE to take some off while keeping a runner`,
    `  • IMPORTANT: Never suggest PARTIAL_CLOSE if the remaining position after close would be < $5 USD. Either HOLD fully or CLOSE fully. Dust positions waste slots.`,
    `  • ADJUST_SL to trail tighter when in profit — lock in gains without rushing out`,
    `\nReply with EXACTLY one of these on the FIRST LINE:`,
    `  HOLD`,
    `  PARTIAL_CLOSE [number 1-99]`,
    `  CLOSE`,
    `  ADJUST_SL [$price]`,
    `Then on the SECOND LINE: one sentence of reasoning — state which supporting/undermining signals swung the decision, and the specific price level for any SL adjustment.`,
    `OPTIONAL THIRD LINE: NEW_SL [$price] — only with HOLD or PARTIAL_CLOSE, only when in profit, to ratchet the stop loss tighter. Longs: must be higher than current SL. Shorts: must be lower than current SL. Omit if not needed.`,
    `Do NOT use HOLD if your reasoning says the thesis is broken or mixed.`,
  ].filter(Boolean).join("\n");

  const reviewSystemCtx = [
    `You are a patient, disciplined futures position manager. You manage conviction, not just stops. When the thesis weakens, you reduce size first — not panic-close. You find the right exit: tighten stops to key levels, take partials when conviction drops, and only market-close when the thesis is fully broken AND loss is accelerating with no recovery signal. Never exit a short at support or a long at resistance — those are the worst prices. Your job is to manage conviction in tiers.`,
    ``,
    `SIGNAL TRUTH TABLE — direction-aware interpretation (apply before any decision):`,
    `  Price at support       → LONG: HOLD (thesis intact) | SHORT: WARNING (bounce risk)`,
    `  Price at resistance    → LONG: WARNING (rejection risk) | SHORT: HOLD (thesis intact)`,
    `  RSI > 70               → LONG: caution (overbought) | SHORT: HOLD (still bearish pressure)`,
    `  RSI < 30               → LONG: HOLD (still bullish pressure) | SHORT: caution (oversold bounce risk)`,
    `  Funding rate positive  → LONG: WARNING (squeeze risk) | SHORT: GOOD (being paid to hold)`,
    `  Funding rate negative  → LONG: GOOD (being paid to hold) | SHORT: WARNING (squeeze risk)`,
    `  OI rising + price up   → LONG: bullish (real demand) | SHORT: PAIN (conviction needed)`,
    `  OI rising + price down → LONG: bearish (real supply) | SHORT: BULLISH (genuine selling)`,
    `  BTC green              → LONG: tailwind | SHORT: headwind`,
    `  BTC red                → LONG: headwind | SHORT: tailwind`,
    `NEVER apply LONG signal logic to a SHORT position or vice versa. A bearish signal is GOOD for shorts.`,
  ].join("\n");

  const resp = await llm.chat({
    taskType: "trade_decision",
    systemContext: reviewSystemCtx,
    userMessage: prompt,
  }).catch(() => null);
  if (!resp) return;

  const text  = resp.text.trim();
  const upper = text.toUpperCase();
  const lines = text.split("\n").filter(Boolean);
  const newSlLine  = lines.find(l => /^NEW_SL\s+\$?[\d.]+/i.test(l));
  const newSlMatch = newSlLine?.match(/NEW_SL\s+\$?([\d.]+)/i);
  const claudeNewSl = newSlMatch ? parseFloat(newSlMatch[1]!) : NaN;
  const reason = lines.slice(1).filter(l => !/^NEW_SL\s/i.test(l)).join(" ") || "";

  const prefix = trigger
    ? `⚡ <b>Immediate review — ${pos.symbol}</b>\nTrigger: ${trigger}`
    : `🔄 <b>Position review — ${pos.symbol} ${dir}</b>`;

  // ADJUST_SL: execute immediately — protective action, no human gate needed
  if (upper.startsWith("ADJUST_SL")) {
    const m    = text.match(/ADJUST_SL\s+\$?([\d.]+)/i);
    const newSl = m ? parseFloat(m[1]!) : NaN;
    if (!isNaN(newSl) && newSl > 0) {
      // Validate SL is on the protective side: SHORT SL must be ABOVE price, LONG SL must be BELOW price
      const liveRef   = (pos as any).markPrice as number ?? pos.entryPrice;
      const isLongPos = pos.side === "Buy";
      const slValid   = isLongPos ? newSl < liveRef : newSl > liveRef;
      if (!slValid) {
        console.warn(`[posMonitor] ADJUST_SL ${pos.symbol} rejected — Claude suggested $${newSl.toFixed(4)} but that is on the wrong side of price $${liveRef.toFixed(4)} for a ${isLongPos ? "LONG" : "SHORT"}`);
        return;
      }
      await bybitSetStopLoss(pos.symbol, newSl, pos.positionIdx)
        .catch(e => console.error(`[posMonitor] ADJUST_SL ${pos.symbol}:`, (e as Error).message));
      const lastNotify = lastAdjustSlNotifyAt[pos.symbol] ?? 0;
      if (Date.now() - lastNotify >= ADJUST_SL_NOTIFY_COOLDOWN_MS) {
        await alertFn?.(`${prefix}\nP/L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%\n\nClaude: ADJUST_SL → $${newSl.toFixed(4)}\n${escapeHtml(reason)}`).catch(e => console.error("[telegram] Send failed:", (e as Error).message));
        lastAdjustSlNotifyAt[pos.symbol] = Date.now();
      } else {
        console.log(`[posMonitor] ADJUST_SL ${pos.symbol} → $${newSl.toFixed(4)} (notify suppressed — cooldown)`);
      }
    }
    return;
  }

  // HOLD: log only, no action
  if (upper.startsWith("HOLD")) {
    console.log(`[posMonitor] HOLD ${pos.symbol} ${dir} P/L:${pnlPct.toFixed(2)}% — ${reason}`);
    return;
  }

  // CLOSE or PARTIAL_CLOSE: execute directly — defensive position management is time-sensitive
  const reviewDecision = lines[0] ?? text;
  console.log(`[posMonitor] Auto-executing ${pos.symbol} ${reviewDecision} — no approval gate for position management`);
  await alertFn?.([
    `${prefix}`,
    `P/L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
    ``,
    `Claude: ${escapeHtml(reviewDecision)}`,
    `Reason: ${escapeHtml(reason.slice(0, 200))}`,
  ].join("\n")).catch(() => {});

  if (upper.startsWith("CLOSE")) {
    await bybitClose(pos.symbol)
      .catch(e => console.error(`[posMonitor] CLOSE ${pos.symbol}:`, (e as Error).message));
    const closeFill = await fetchActualFillPrice(pos.symbol, pos.entryPrice, pos.markPrice ?? pos.entryPrice);
    await closeOpenTrade({ symbol: pos.symbol, broker: "bybit", exitPrice: closeFill, amountUsd: pos.size * pos.entryPrice, entryPriceOverride: pos.entryPrice, directionOverride: pos.side === "Buy" ? "long" : "short", exitReason: "review" }).catch(() => {});
    await clearPositionMeta(pos.symbol).catch(() => {});
    await alertFn?.(`${prefix}\nP/L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%\n\nClaude: CLOSE ✅ executed\n${escapeHtml(reason)}`).catch(e => console.error("[telegram] Send failed:", (e as Error).message));

  } else if (upper.startsWith("PARTIAL_CLOSE")) {
    const m   = text.match(/PARTIAL_CLOSE\s+(\d+)/i);
    const pct = Math.min(99, Math.max(1, parseInt(m?.[1] ?? "50", 10)));

    const currentSizeUsd  = pos.size * (pos.markPrice ?? pos.entryPrice);
    const afterPartialUsd = currentSizeUsd * (1 - pct / 100);

    if (afterPartialUsd < 5) {
      if (currentSizeUsd < 5) {
        // Position already dust — close fully
        await bybitClose(pos.symbol)
          .catch(e => console.error(`[posMonitor] CLOSE (dust) ${pos.symbol}:`, (e as Error).message));
        const dustFill = await fetchActualFillPrice(pos.symbol, pos.entryPrice, pos.markPrice ?? pos.entryPrice);
        await closeOpenTrade({ symbol: pos.symbol, broker: "bybit", exitPrice: dustFill, amountUsd: pos.size * pos.entryPrice, entryPriceOverride: pos.entryPrice, directionOverride: pos.side === "Buy" ? "long" : "short", exitReason: "review" }).catch(() => {});
        await clearPositionMeta(pos.symbol).catch(() => {});
        await alertFn?.(`${prefix}\nP/L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%\n\nPartial → CLOSE (position is dust $${currentSizeUsd.toFixed(2)})\n${escapeHtml(reason)}`).catch(e => console.error("[telegram] Send failed:", (e as Error).message));
      } else {
        // Partial would leave dust — skip and hold
        console.log(`[posMonitor] PARTIAL_CLOSE ${pos.symbol} skipped — would leave dust ($${afterPartialUsd.toFixed(2)})`);
        await alertFn?.(`${prefix}\nP/L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%\n\n⚠️ Partial close skipped — would leave dust ($${afterPartialUsd.toFixed(2)})\nHOLDING\n${escapeHtml(reason)}`).catch(e => console.error("[telegram] Send failed:", (e as Error).message));
      }
    } else {
      await closePercentPosition(pos.symbol, pct)
        .catch(e => console.error(`[posMonitor] PARTIAL_CLOSE ${pos.symbol}:`, (e as Error).message));
      logPartialClose({ symbol: pos.symbol, partialType: "review_partial", closePct: pct, priceAtClose: currentPrice, pnlPct, remainingPct: 100 - pct }).catch(() => {});
      await alertFn?.(`${prefix}\nP/L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%\n\nClaude: PARTIAL_CLOSE ${pct}% ✅ executed\n${escapeHtml(reason)}`).catch(e => console.error("[telegram] Send failed:", (e as Error).message));
    }
  }

  // Apply Claude's optional ratchet SL (valid with HOLD or PARTIAL_CLOSE; skipped for CLOSE/ADJUST_SL)
  const didFullClose = upper.startsWith("CLOSE") || upper.startsWith("ADJUST_SL");
  if (!didFullClose && !isNaN(claudeNewSl) && claudeNewSl > 0) {
    const currentSlRaw = meta?.sl ?? pos.stopLoss ?? 0;
    const currentSlNum = typeof currentSlRaw === "number" ? currentSlRaw : parseFloat(String(currentSlRaw) || "0");
    const ratchetOk = isLong ? claudeNewSl > currentSlNum : (currentSlNum === 0 || claudeNewSl < currentSlNum);
    if (ratchetOk) {
      await bybitSetStopLoss(pos.symbol, claudeNewSl, pos.positionIdx)
        .catch(e => console.warn(`[posMonitor] newSl update ${pos.symbol}:`, (e as Error).message));
      await patchPositionMeta(pos.symbol, { sl: claudeNewSl });
      db.update(tradeLogTable).set({ effectiveSl: String(claudeNewSl) })
        .where(and(eq(tradeLogTable.symbol, pos.symbol), isNull(tradeLogTable.exitAt))).catch(() => {});
      console.log(`[posMonitor] ${pos.symbol} SL ratchet → $${claudeNewSl.toFixed(4)} (was $${currentSlNum.toFixed(4)})`);
    } else {
      console.warn(`[posMonitor] ${pos.symbol} NEW_SL $${claudeNewSl.toFixed(4)} rejected — ratchet check failed (current $${currentSlNum.toFixed(4)}, ${isLong ? "LONG" : "SHORT"})`);
    }
  }
}

export function startPositionMonitor(alertFn?: (msg: string) => Promise<void>): void {
  setInterval(() => {
    void checkPositionMonitor().catch(e => console.error("[posMonitor]", e));
  }, MONITOR_INTERVAL_MS);
  if (alertFn) startWeeklyAbReportCron(alertFn);
  startPaperMonitorCron(alertFn);

  // 9am SGT (= 1am UTC) daily DB health check
  cron.schedule("0 1 * * *", async () => {
    try {
      await db.select({ id: botStateTable.id }).from(botStateTable).limit(1);
      await alertFn?.("✅ DB healthy — Railway connection OK").catch(e => console.error("[telegram] Send failed:", (e as Error).message));
      console.log("[dbHealth] Daily check: OK");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await alertFn?.(`⚠️ DB connection failed\n${msg.slice(0, 200)}`).catch(e => console.error("[telegram] Send failed:", (e as Error).message));
      console.error("[dbHealth] Daily check FAILED:", e);
    }
  });

  // Midnight SGT (= 16:00 UTC) daily position summary — no Claude call
  cron.schedule("0 16 * * *", async () => {
    try {
      const positions = await bybitGetPositions().catch(() => [] as BybitPosition[]);
      if (!positions.length) {
        await alertFn?.("🌙 Daily summary — no open positions").catch(e => console.error("[telegram] Send failed:", (e as Error).message));
        return;
      }
      const state   = await loadBotState().catch(() => null);
      const posMeta = (state?.positionMetadata ?? {}) as Record<string, PositionMeta>;
      const fmtHeld = (openedAt: number | undefined) => {
        if (!openedAt) return "?";
        const ms = Date.now() - openedAt;
        const h  = Math.floor(ms / 3_600_000);
        return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
      };
      const lines = positions.map(pos => {
        const meta    = posMeta[pos.symbol];
        const pnlPct  = pos.pnlPct ?? 0;
        const peak    = meta?.peakPnlPct;
        const peakStr = peak != null && peak - pnlPct > 0.1 ? ` (peak: ${peak >= 0 ? "+" : ""}${peak.toFixed(2)}%)` : "";
        const sl      = meta?.sl ?? pos.stopLoss;
        const tp1     = meta?.tp1 ?? pos.takeProfit;
        const dir     = pos.side === "Buy" ? "LONG" : "SHORT";
        const held    = fmtHeld(meta?.openedAt);
        return [
          `<b>${pos.symbol}</b> ${dir} | Entry: $${pos.entryPrice.toFixed(4)} | Now: $${(pos.markPrice ?? pos.entryPrice).toFixed(4)}`,
          `P/L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%${peakStr} | SL: ${sl ? "$" + (typeof sl === "number" ? sl.toFixed(4) : sl) : "—"} | TP1: ${tp1 ? "$" + (typeof tp1 === "number" ? tp1.toFixed(4) : tp1) : "—"} | Held: ${held}`,
        ].join("\n");
      });
      await alertFn?.([`🌙 <b>Daily summary — 00:00 SGT</b>`, "", ...lines].join("\n\n")).catch(e => console.error("[telegram] Send failed:", (e as Error).message));
      console.log(`[dailySummary] Sent — ${positions.length} open positions`);
    } catch (e) {
      console.error("[dailySummary] Failed:", e);
    }
  });

  console.log("[posMonitor] Started — checks every 5 min");
  console.log("[dbHealth] Daily 9am SGT DB health check scheduled");
  console.log("[dailySummary] Daily midnight SGT position summary scheduled");
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export function startCronScanner(): void {
  if (SCAN_INTERVAL === "disabled") {
    cronEnabled = false;
    console.log("[cronScanner] Auto-scan DISABLED — manual trigger only (/autoscan now)");
    return;
  }
  const interval = cron.validate(SCAN_INTERVAL) ? SCAN_INTERVAL : "*/30 * * * *";
  if (!cron.validate(SCAN_INTERVAL)) console.warn(`[cronScanner] Invalid SCAN_INTERVAL, using every 30 min`);
  cronTask = cron.schedule(interval, () => { void runCronScan("cron").catch(e => console.error("[cronScanner] unhandled:", e)); });
  console.log(`[cronScanner] Started — schedule: ${humanInterval(interval)}`);
}

export function setCronEnabled(enabled: boolean): void {
  cronEnabled = enabled;
  if (enabled) cronTask?.start(); else cronTask?.stop();
  console.log(`[cronScanner] ${enabled ? "Enabled" : "Disabled"}`);
}

export function resumeTrading(): void {
  tradingPaused = false;
  pausedReason  = "";
  // Reset peak_equity and resumeAt so both drawdown and daily P&L checks start fresh
  const resumeTimestamp = new Date();
  syncTotalCapitalToDB().then(balances => {
    const currentBalance = (balances?.bybit ?? 0) > 0 ? balances!.bybit : undefined;
    db.update(botStateTable).set({
      tradingPaused: false,
      pausedReason:  null,
      lastUpdated:   new Date(),
      resumeAt:      resumeTimestamp,
      ...(currentBalance != null ? { peakEquity: currentBalance } : {}),
    }).where(eq(botStateTable.id, 1)).catch(() => {});
    if (currentBalance != null) {
      console.log(`[cronScanner] Trading resumed — peak_equity reset to $${currentBalance.toFixed(2)}, daily P&L window reset to ${resumeTimestamp.toISOString()}`);
    } else {
      console.log(`[cronScanner] Trading resumed — daily P&L window reset to ${resumeTimestamp.toISOString()}`);
    }
  }).catch(() => {
    db.update(botStateTable).set({ tradingPaused: false, pausedReason: null, lastUpdated: new Date(), resumeAt: resumeTimestamp })
      .where(eq(botStateTable.id, 1)).catch(() => {});
    console.log("[cronScanner] Trading resumed");
  });
}

export async function triggerNow(): Promise<void> { return runCronScan("manual"); }

export function getStatus() {
  const interval = currentInterval || "0 */4 * * *";
  return {
    enabled:      cronEnabled,
    paused:       tradingPaused,
    pausedReason,
    lastScan:     lastScanTime,
    interval,
    schedule:     humanInterval(interval),
  };
}

export function restartCron(shorthandOrExpr: string): { schedule: string; expr: string } {
  const expr = CRON_SHORTHANDS[shorthandOrExpr] ?? shorthandOrExpr;
  if (!cron.validate(expr)) throw new Error(`Invalid interval: ${shorthandOrExpr}`);
  cronTask?.stop();
  cronTask = null;
  currentInterval = expr;
  if (cronEnabled) {
    cronTask = cron.schedule(expr, () => { void runCronScan("cron").catch(e => console.error("[cronScanner] unhandled:", e)); });
  }
  console.log(`[cronScanner] Interval changed → ${humanInterval(expr)}`);
  return { schedule: humanInterval(expr), expr };
}
