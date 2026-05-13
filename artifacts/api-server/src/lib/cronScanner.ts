import cron, { type ScheduledTask }   from "node-cron";
import { runScan, type ScanResult, type ScanOpportunity, calcATR } from "./marketScanner";
import { cache, CacheKey }             from "./contextCache";
import { approvalGate, buildProposal } from "./approvalGate";
import { syncTotalCapitalToDB }        from "./brokerBalance";
import { isCoinSuspended, updateDailyPnl } from "./leverageManager";
import { getDailyPnl, logOpenTrade, closeOpenTrade, getOpenTrades } from "./tradeMemoryLib";
import { llm }                         from "./llmRouter";
import {
  getPositions    as bybitGetPositions,
  closePosition   as bybitClose,
  cancelOrder     as bybitCancelOrder,
  getOrders       as bybitGetOrders,
  closePercentPosition,
  setStopLoss     as bybitSetStopLoss,
  getFundingRate,
  getKlines,
  type BybitPosition,
} from "../brokers/bybit";
import { db, profileTable, botStateTable, tradeMemoryTable, type PositionMeta } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

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

let cronTask:   ScheduledTask | null = null;
let isScanning: boolean              = false;

type ScanNotifier  = (result: ScanResult, triggered: "cron" | "manual") => Promise<void>;
type AlertNotifier = (message: string) => Promise<void>;

let notifyFn: ScanNotifier  | null = null;
let alertFn:  AlertNotifier | null = null;

export function registerScanNotifier(fn: ScanNotifier): void  { notifyFn = fn; }
export function registerAlertNotifier(fn: AlertNotifier): void { alertFn  = fn; }

const SCAN_INTERVAL     = process.env["SCAN_INTERVAL"] ?? "*/30 * * * *";
const MAX_AUTO_TRADES   = parseInt(process.env["MAX_TRADES_PER_SCAN"] ?? "3");
const DAILY_LOSS_PCT    = 0.15;   // halt at -15% daily loss
const DRAWDOWN_PCT      = 0.35;   // halt at -35% from peak equity
const EQUITY_CLASSES    = new Set(["Equity", "US Equity", "equity", "Stock", "stock", "ETF", "etf"]);
const STARTING_BALANCE  = 50;     // initial deposit for profit protection calc

function humanInterval(crontab: string): string {
  if (crontab === "disabled")      return "disabled (manual only)";
  if (crontab === "*/30 * * * *")  return "every 30 minutes";
  if (crontab === "*/15 * * * *")  return "every 15 minutes";
  if (crontab === "0 */4 * * *")   return "every 4 hours";
  if (crontab === "0 */1 * * *")   return "every hour";
  return crontab;
}

type ScalingAction = "NEW" | "ADD" | "HOLD" | "CUT" | "TIER1" | "TIER2";

interface SignalOutcome {
  symbol:   string;
  action:   ScalingAction;
  amount?:  number;
  reason?:  string;
  pnlPct?:  number;
}

// ── bot_state helpers ─────────────────────────────────────────────────────────
async function loadBotState() {
  const [row] = await db.select().from(botStateTable).limit(1);
  if (row) return row;
  await db.insert(botStateTable).values({ id: 1 }).onConflictDoNothing();
  const [fresh] = await db.select().from(botStateTable).limit(1);
  return fresh!;
}

async function saveBotState(patch: Partial<typeof botStateTable.$inferInsert>): Promise<void> {
  await db.update(botStateTable).set({ ...patch, lastUpdated: new Date() }).where(eq(botStateTable.id, 1));
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
      await alertFn?.(msg).catch(() => {});
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
      await alertFn?.(msg).catch(() => {});
      console.warn("[cronScanner] Daily loss limit hit — trading paused");
      return false;
    }

    return true;
  } catch { return true; }
}

// ── Layer 4: Risk-based position sizing ───────────────────────────────────────
function calcRiskBasedSize(
  bybitBalance: number,
  stopLoss:     number,
  entry:        number,
  leverage:     number,
): number {
  if (!stopLoss || !entry || entry === stopLoss) return Math.min(5, bybitBalance * 0.05);
  const stopLossPct  = Math.abs(entry - stopLoss) / entry;
  const positionRisk = bybitBalance * 0.05;                        // 5% equity risk
  const notional     = positionRisk / stopLossPct;                 // notional size
  const margin       = notional / leverage;                        // margin required
  const capped       = Math.min(margin, bybitBalance * 0.30);      // cap at 30% equity
  return Math.max(5, parseFloat(capped.toFixed(2)));               // min $5
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
    // Filter 1: hard regime blocks — CHOPPY (no trend/no range), EXHAUSTION, VOLATILE
    // RANGING is allowed through: range trades at support/resistance are valid entries
    if (regime?.regime === "CHOPPY" ||
        regime?.regime === "EXHAUSTION" ||
        regime?.regime === "VOLATILE") {
      rejected.push({ symbol: opp.symbol, reason: `regime=${regime.regime} — no new entries` });
      continue;
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
async function cancelStaleOrders(): Promise<void> {
  try {
    const orders = await bybitGetOrders();
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    for (const order of orders) {
      const placedAt = new Date(order.placedAt).getTime();
      if (placedAt < tenMinAgo) {
        await bybitCancelOrder(order.symbol, order.orderId).catch(e =>
          console.warn(`[cronScanner] Cancel order ${order.orderId} failed:`, e.message)
        );
        await alertFn?.(`❌ Stale order cancelled — ${order.symbol}\nLimit $${order.price} not filled after 10 min`).catch(() => {});
        console.log(`[cronScanner] Cancelled stale order ${order.orderId} ${order.symbol}`);
      }
    }
  } catch (e) {
    console.warn("[cronScanner] staleOrderCheck failed:", (e as Error).message);
  }
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
        await closeOpenTrade({
          symbol: pos.symbol, broker: "bybit",
          exitPrice: currentPrice, amountUsd: pos.size * pos.entryPrice,
          entryPriceOverride: pos.entryPrice,
        }).catch(() => {});
        await alertFn?.([
          `⏱️ 48h review — ${pos.symbol}`,
          `Decision: CLOSE`,
          `Reason: ${reason}`,
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
        `Decision: ${decision}`,
        `Reason: ${reason}`,
        `Next review: 24h`,
      ].join("\n")).catch(() => {});
    }
  }
}

// ── Layer 5: Partial exit monitoring (tier-based) ────────────────────────────
async function checkPartialExits(livePositions: BybitPosition[]): Promise<void> {
  const state = await loadBotState().catch(() => null);
  if (!state) return;
  const meta = (state.positionMetadata ?? {}) as Record<string, PositionMeta>;

  for (const pos of livePositions) {
    const pm = meta[pos.symbol];
    if (!pm) continue; // no metadata — skip until next open stores it

    const origQty = pm.originalQty;
    if (!origQty || origQty <= 0) continue;

    const qtyRatio = pos.size / origQty;
    // Infer current tier from qty ratio
    const currentTier = qtyRatio > 0.85 ? 0 : qtyRatio > 0.55 ? 1 : qtyRatio > 0.25 ? 2 : 3;

    // Current price inferred from P/L
    const currentPrice = pos.side === "Buy"
      ? pos.entryPrice + (pos.pnl / Math.max(pos.size, 0.00001))
      : pos.entryPrice - (pos.pnl / Math.max(pos.size, 0.00001));

    // Tier 1: price reached TP1 and no partial yet
    if (currentTier === 0 && pm.tp1 > 0) {
      const tp1Reached = pos.side === "Buy" ? currentPrice >= pm.tp1 : currentPrice <= pm.tp1;
      if (tp1Reached) {
        console.log(`[cronScanner] Tier 1 exit: ${pos.symbol} price=$${currentPrice.toFixed(4)} tp1=$${pm.tp1}`);
        try {
          await closePercentPosition(pos.symbol, 30);
          // Move SL to breakeven
          await bybitSetStopLoss(pos.symbol, pm.entryPrice, pos.positionIdx)
            .catch(e => console.warn(`[cronScanner] Breakeven SL failed ${pos.symbol}:`, e.message));
          const banked = pos.pnl * 0.30;
          await alertFn?.([
            `💰 Tier 1 profit banked — ${pos.symbol}`,
            `Closed: 30% at ~$${currentPrice.toFixed(4)}`,
            `P/L banked: +$${banked.toFixed(2)}`,
            `SL moved to breakeven: $${pm.entryPrice.toFixed(4)}`,
            `Remaining: 70% position running`,
          ].join("\n")).catch(() => {});
        } catch (e) {
          console.error(`[cronScanner] Tier 1 exit ${pos.symbol} failed:`, (e as Error).message);
        }
        continue;
      }
    }

    // Tier 2: price reached TP2 and tier 1 already done
    if (currentTier === 1 && pm.tp2 > 0) {
      const tp2Reached = pos.side === "Buy" ? currentPrice >= pm.tp2 : currentPrice <= pm.tp2;
      if (tp2Reached) {
        console.log(`[cronScanner] Tier 2 exit: ${pos.symbol} price=$${currentPrice.toFixed(4)} tp2=$${pm.tp2}`);
        try {
          // Close 30% of original qty (another 30%, total 60% out)
          const qty30pctOfOrig = origQty * 0.30;
          await closePercentPosition(pos.symbol, Math.round((qty30pctOfOrig / pos.size) * 100));
          const banked = pos.pnl * 0.30;
          await alertFn?.([
            `💰 Tier 2 profit banked — ${pos.symbol}`,
            `Closed: another 30% at ~$${currentPrice.toFixed(4)}`,
            `P/L banked: +$${banked.toFixed(2)}`,
            `Remaining: 40% with trailing SL`,
          ].join("\n")).catch(() => {});
        } catch (e) {
          console.error(`[cronScanner] Tier 2 exit ${pos.symbol} failed:`, (e as Error).message);
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
      regime.summary,
    ].join("\n")).catch(() => {});

    for (const pos of livePositions) {
      await closePercentPosition(pos.symbol, 50).catch(e =>
        console.warn(`[cronScanner] Regime flatten ${pos.symbol}:`, e.message)
      );
    }
  }
}

// ── Log scaling decision ──────────────────────────────────────────────────────
async function logScalingDecision(
  symbol:    string,
  action:    ScalingAction,
  reasoning: string,
  pnlPct?:   number,
): Promise<void> {
  await db.insert(tradeMemoryTable).values({
    symbol,
    reflection: reasoning,
    whatWorked: String(action),
    whatDidnt:  pnlPct != null ? `P/L at decision: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : null,
  }).catch(e => console.error("[cronScanner] logScalingDecision failed:", e));
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
  symbol: string;
  action: "HOLD" | "ADD" | "CUT";
  reason: string;
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

  const signalContext = opps.slice(0, 5)
    .map(s => `${s.symbol} ${s.recommendation} score=${s.score} direction=${s.direction ?? "?"}`)
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
    const slStr  = p.stopLoss   ? ` SL=$${p.stopLoss}`   : "";
    const tpStr  = p.takeProfit ? ` TP=$${p.takeProfit}`  : "";
    const ctx    = enriched[i];
    if (ctx?.status === "fulfilled") {
      const { direction, frNote, keyLevelNote } = ctx.value;
      return [
        `- ${p.symbol} ${direction} ${p.leverage}x entry=$${p.entryPrice.toFixed(4)} P/L=${pnlStr}${slStr}${tpStr}`,
        `  Key level: ${keyLevelNote}`,
        `  Funding:   ${frNote}`,
      ].join("\n");
    }
    return `- ${p.symbol} ${p.side === "Buy" ? "LONG" : "SHORT"} ${p.leverage}x entry=$${p.entryPrice.toFixed(4)} P/L=${pnlStr}${slStr}${tpStr}`;
  }).join("\n");

  const addRule = bybitBalance < 200
    ? `ADD rule: balance $${bybitBalance.toFixed(2)} < $200 — NEVER ADD to existing positions. Return HOLD instead of ADD always. Single-entry precision only.`
    : `ADD rule: balance $${bybitBalance.toFixed(2)} >= $200 — ADD only on strongest conviction (+3% P/L) with clear trend continuation, not already scaled.`;

  const systemContext = [
    "You are a disciplined quant managing a Bybit live futures account. Respond JSON only.",
    "",
    "LONG position: profitable when price rises. HOLD if: bullish momentum intact, price above support, funding supports long.",
    "SHORT position: profitable when price falls. HOLD if: bearish momentum intact, price at/below resistance, funding supports short, NO bullish reversal.",
    "CRITICAL for SHORT: price hitting resistance = thesis intact = HOLD. Bearish signals = GOOD for short = HOLD. Bullish signals = threat = CUT.",
    "CRITICAL for LONG: price at support = HOLD. Bullish signals = HOLD. Bearish breakdown = CUT.",
    "NEVER apply long logic to short positions or vice versa.",
    "",
    addRule,
    "CUT if P/L < -8% OR opposite-direction reversal confirmed. HOLD otherwise.",
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
              symbol: { type: "string" },
              action: { type: "string", enum: ["HOLD", "ADD", "CUT"] },
              reason: { type: "string" },
            },
          },
        },
      },
    },
    fallback: { positions: [] },
  });

  return res.data;
}

async function handlePositionDecision(
  decision:      PositionDecision,
  livePositions: BybitPosition[],
  bybitBalance:  number,
  outcomes:      SignalOutcome[],
): Promise<void> {
  const sym = decision.symbol;
  const pos = livePositions.find(p =>
    p.symbol === sym || p.symbol === bybitSym(sym) || bybitSym(p.symbol) === bybitSym(sym)
  );

  if (!pos) {
    console.log(`[cronScanner] ${sym} position not found for action ${decision.action}`);
    return;
  }

  if (decision.action === "HOLD") {
    await logScalingDecision(sym, "HOLD", decision.reason, pos.pnlPct);
    outcomes.push({ symbol: sym, action: "HOLD", reason: decision.reason, pnlPct: pos.pnlPct });
    return;
  }

  if (decision.action === "CUT") {
    try {
      await bybitClose(sym);
      const exitPrice = pos.entryPrice + (pos.pnl / Math.max(pos.size, 0.0001));
      await closeOpenTrade({ symbol: sym, broker: "bybit", exitPrice, amountUsd: pos.size * pos.entryPrice, entryPriceOverride: pos.entryPrice }).catch(() => {});
      await logScalingDecision(sym, "CUT", decision.reason, pos.pnlPct);
      outcomes.push({ symbol: sym, action: "CUT", reason: decision.reason, pnlPct: pos.pnlPct });
      const sign = pos.pnl >= 0 ? "+" : "";
      await alertFn?.(`✂️ Position CUT: ${sym}\nP/L: ${sign}$${pos.pnl.toFixed(2)} (${sign}${pos.pnlPct.toFixed(2)}%)\nReason: ${decision.reason}`).catch(() => {});
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
    const riskSize = calcRiskBasedSize(bybitBalance, pos.stopLoss ?? 0, pos.entryPrice, pos.leverage);
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

// ── Format scan summary for Telegram ─────────────────────────────────────────
function formatScanSummary(
  outcomes:  SignalOutcome[],
  total:     number,
  regime:    ScanResult["regime"],
  rejected:  Array<{ symbol: string; reason: string }>,
  dailyPnl:  number,
  balance:   number,
): string {
  const regimeEmoji: Record<string, string> = {
    STRONG_TREND: "🚀", TRENDING_UP: "📈", TRENDING_DOWN: "📉",
    RANGING: "↕️", CHOPPY: "↔️", EXHAUSTION: "⚠️", VOLATILE: "⚡",
  };
  const re = regime ? `${regimeEmoji[regime.regime] ?? "?"} ${regime.regime} | ADX:${regime.adx.toFixed(0)} ATR:${regime.atr.toFixed(0)}` : "? Unknown";
  const dailyTag = `${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)} (${dailyPnl >= 0 ? "+" : ""}${balance > 0 ? (dailyPnl / balance * 100).toFixed(1) : "?"}%)`;

  const lines = [
    `🔍 <b>Scan complete</b> — ${re}`,
    ``,
  ];

  if (rejected.length) {
    lines.push(`🚫 <b>Filtered (${rejected.length}):</b>`);
    for (const r of rejected) lines.push(`  • ${r.symbol} — ${r.reason}`);
    lines.push(``);
  }

  const newEntries = outcomes.filter(o => o.action === "NEW" || o.action === "ADD");
  const holds      = outcomes.filter(o => o.action === "HOLD");
  const cuts       = outcomes.filter(o => o.action === "CUT");

  if (newEntries.length) {
    lines.push(`📊 <b>Executed (${newEntries.length}):</b>`);
    for (const o of newEntries) lines.push(`  • ${o.symbol} ${o.action} — $${o.amount ?? "?"}`);
    lines.push(``);
  }

  if (cuts.length) {
    for (const o of cuts) {
      const pnlTag = o.pnlPct != null ? ` (${o.pnlPct >= 0 ? "+" : ""}${o.pnlPct.toFixed(1)}%)` : "";
      lines.push(`✂️ Cut: ${o.symbol}${pnlTag}`);
    }
    lines.push(``);
  }

  if (holds.length) {
    lines.push(`⏸️ <b>Held (${holds.length}):</b> ${holds.map(o => o.symbol).join(", ")}`);
  }

  lines.push(`💰 Daily P/L: ${dailyTag} | Balance: $${balance.toFixed(2)}`);
  if (outcomes.length === 0 && !rejected.length) {
    lines.push(`⏭️ No actions taken`);
  }

  return lines.join("\n");
}

// ── Core scan logic ───────────────────────────────────────────────────────────
async function runCronScan(triggered: "cron" | "manual" = "cron"): Promise<void> {
  if (!cronEnabled && triggered === "cron") { console.log("[cronScanner] Skipped — disabled"); return; }
  if (tradingPaused)                         { console.log("[cronScanner] Skipped — trading paused"); return; }
  if (isScanning)                            { console.log("[cronScanner] Skipped — scan already in progress"); return; }

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

    // Notify Telegram of scan result
    await notifyFn?.(result, triggered).catch(e => console.error("[cronScanner] notify failed:", e));

    const outcomes: SignalOutcome[] = [];

    // Crypto-only signals
    const cryptoOpps = result.opportunities.filter(o => !EQUITY_CLASSES.has(o.assetClass ?? ""));

    // ── Layer 4: Portfolio allocator ──────────────────────────────────────────
    const maxPositions    = bybitBalance < 200 ? 3 : Math.floor(bybitBalance / 10);
    const availableSlots  = Math.max(0, maxPositions - livePositions.length);

    if (livePositions.length >= maxPositions) {
      console.log(`[cronScanner] ⚠️ Max positions reached (${livePositions.length}/${maxPositions}) — skipping new entries`);
    }

    // Position review for existing positions
    const posReview = await makePositionReview(cryptoOpps, livePositions, bybitBalance);
    for (const posDecision of posReview.positions) {
      await handlePositionDecision(posDecision, livePositions, bybitBalance, outcomes).catch(e =>
        console.error(`[cronScanner] posDecision ${posDecision.symbol}:`, e)
      );
    }

    // Layer 2: Apply hard filters to new signals
    const existingSyms  = new Set(livePositions.map(p => bybitSym(p.symbol)));
    const newSignals    = cryptoOpps.filter(o =>
      (o.conviction === "strong_buy" || o.conviction === "strong_sell") &&
      !existingSyms.has(bybitSym(o.symbol)) &&
      (o.score ?? 0) >= 65
    );

    const { passed: filteredSignals, rejected } = await applyHardFilters(newSignals, regime);

    if (rejected.length) {
      console.log(`[cronScanner] Hard filters rejected: ${rejected.map(r => `${r.symbol}(${r.reason})`).join(", ")}`);
    }

    // Layer 4: rank by score, take top available slots
    const rankedSignals = filteredSignals
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, availableSlots)
      .slice(0, MAX_AUTO_TRADES);

    for (const opp of rankedSignals) {
      if (await isCoinSuspended(opp.symbol)) continue;
      const sym = bybitSym(opp.symbol);

      // Layer 4+5: risk-based sizing
      const amountUsd = calcRiskBasedSize(
        bybitBalance,
        opp.stopLoss  ?? 0,
        opp.entry     ?? opp.price,
        opp.leverage  ?? 10,
      );

      const proposal = buildProposal({
        symbol:          sym,
        side:            opp.direction === "short" ? "sell" : "buy",
        amountUsd,
        assetClass:      opp.assetClass,
        broker:          "bybit",
        rationale:       `[Cron] ${opp.recommendation} score=${opp.score} regime=${regime?.regime ?? "?"}. ${opp.reasoning ?? ""}`,
        score:           opp.score,
        currentPrice:    opp.price,
        dataTimestamp:   opp.dataTimestamp,
        stopLossPrice:   opp.stopLoss,
        takeProfitPrice: opp.takeProfit,
      });
      const gateResult = await approvalGate.submit(proposal).catch(e => {
        console.error(`[cronScanner] submit ${sym}:`, e);
        return { action: "failed" as const, proposal, message: String(e), orderId: undefined };
      });
      outcomes.push({
        symbol: sym, amount: amountUsd,
        action: gateResult.action === "executed" ? "NEW" : "HOLD",
        reason: gateResult.message,
      });
    }

    // Telegram summary
    const dailyPnl = await getDailyPnl().catch(() => 0);
    const summary  = formatScanSummary(outcomes, result.opportunities.length, regime, rejected, dailyPnl, bybitBalance);
    await alertFn?.(summary).catch(() => {});

    console.log(`[cronScanner] Complete — ${result.opportunities.length} signals, ${filteredSignals.length} passed filters, ${rankedSignals.length} actioned`);
  } catch (err) {
    console.error("[cronScanner] Scan failed:", err);
  } finally {
    isScanning = false;
  }
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
  cronTask = cron.schedule(interval, () => { void runCronScan("cron"); });
  setTimeout(() => { void runCronScan("cron"); }, 10_000);
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
  db.update(botStateTable).set({ tradingPaused: false, pausedReason: null, lastUpdated: new Date() })
    .where(eq(botStateTable.id, 1)).catch(() => {});
  console.log("[cronScanner] Trading resumed");
}

export async function triggerNow(): Promise<void> { return runCronScan("manual"); }

export function getStatus() {
  return {
    enabled:      cronEnabled,
    paused:       tradingPaused,
    pausedReason,
    lastScan:     lastScanTime,
    interval:     SCAN_INTERVAL,
    schedule:     humanInterval(SCAN_INTERVAL),
  };
}
