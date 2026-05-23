import {
  db, tradeLogTable, tradeMemoryTable, paperTradesTable, botStateTable,
  tradingRulesTable, ruleOverridesTable, type TradingRule,
} from "@workspace/db";
import { desc, isNotNull, and, eq, isNull, asc, gte, lte, gt, inArray } from "drizzle-orm";
import { llm }                                from "./llmRouter";
import { recordTradeOutcome }                 from "./leverageManager";
import { getClosedPnl as bybitGetClosedPnl, getKlines }  from "../brokers/bybit";

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
  sl?:           string | null;
  tp1?:          string | null;
  tp2?:          string | null;
  sourceTradeId?: string | null;
  markPriceAtDecision?: number;  // pre-order price the system used
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

async function generateReflection(input: ReflectionInput): Promise<void> {
  const sign = input.pnl >= 0 ? "+" : "";

  // 1. Fetch Bybit closed-pnl for this symbol within the trade window
  type BybitClose = { closedSize: number; avgExitPrice: number; avgEntryPrice: number; closedPnl: number; closedAt: number; openedAt: number; side: string };
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

  // ── Execution quality checks ──────────────────────────────────────────────
  const tp1Price   = input.tp1   ? parseFloat(input.tp1)  : 0;
  const tp2Price   = input.tp2   ? parseFloat(input.tp2)  : 0;
  const plannedSL  = input.sl    ? parseFloat(input.sl)   : 0;

  const tp1Reached = checkCandlesReachedPrice(tradePeriodCandles, tp1Price, input.direction as "long" | "short");
  const tp2Reached = checkCandlesReachedPrice(tradePeriodCandles, tp2Price, input.direction as "long" | "short");
  const tp1Executed = memPartials.some(p => p.partialType === "tp1");
  const tp2Executed = memPartials.some(p => p.partialType === "tp2");

  const maxProfitPct = getMaxProfitDuringHold(tradePeriodCandles, input.entryPrice, input.direction as "long" | "short");

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
  if (maxProfitPct >= 5  && !memPartials.some(p => p.partialType === "profit_5pct"))  executionIssues.push("5% profit protection missed");
  if (maxProfitPct >= 10 && !memPartials.some(p => p.partialType === "profit_10pct")) executionIssues.push("10% profit protection missed");
  if (maxProfitPct >= 20 && !memPartials.some(p => p.partialType === "profit_20pct")) executionIssues.push("20% profit protection missed");
  if (slippage > 0.5)     executionIssues.push(`Significant slippage: ${slippage.toFixed(2)}%`);
  if (plannedSL > 0) {
    const slDirectionOk = input.direction === "long" ? plannedSL < input.entryPrice : plannedSL > input.entryPrice;
    if (!slDirectionOk) executionIssues.push("SL direction wrong");
  }
  const unplannedPartials = memPartials.filter(p =>
    !["tp1","tp2","profit_5pct","profit_10pct","profit_20pct","large_profit"].includes(p.partialType ?? "")
  );
  if (unplannedPartials.length > 0) executionIssues.push(`Unplanned partials: ${unplannedPartials.map(p => p.partialType).join(", ")}`);
  if (memPartials.length > 3) executionIssues.push(`Excessive partials: ${memPartials.length} closes`);

  // Determine exit method from bybit data and partials
  const profitProtectionTypes = ["profit_5pct","profit_10pct","profit_20pct","large_profit"];
  const exitMethod = memPartials.some(p => profitProtectionTypes.includes(p.partialType ?? ""))
    ? "profit_protection"
    : bybitCloses.length > 0 && bybitCloses[bybitCloses.length-1]!.closedPnl !== undefined
      ? (input.pnlPct < -5 ? "sl_hit" : "review")
      : "unknown";

  const tradeLost = input.pnlPct < 0;
  const failureType: "strategy" | "execution" | "mixed" | "success" =
    !tradeLost          ? "success"
    : executionIssues.length > 2 ? "execution"
    : executionIssues.length > 0 ? "mixed"
    : "strategy";

  const profitProtectionMissed = (maxProfitPct >= 5 && !memPartials.some(p => p.partialType === "profit_5pct"))
    || (maxProfitPct >= 10 && !memPartials.some(p => p.partialType === "profit_10pct"))
    || (maxProfitPct >= 20 && !memPartials.some(p => p.partialType === "profit_20pct"));

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

  // 6. Prompt
  const prompt = [
    `Complete trade record for structured reflection:`,
    ``,
    `Symbol: ${input.symbol}`,
    `Direction: ${input.direction} (confirmed from Bybit side field)`,
    `Entry: $${input.entryPrice.toFixed(4)}${input.entryAt ? ` at ${toSGT(input.entryAt)}` : ""}`,
    `Final exit: $${input.exitPrice.toFixed(4)}${input.exitAt ? ` at ${toSGT(input.exitAt)}` : ""}`,
    holdHours !== null ? `Hold duration: ${holdHours}h ${holdMinutes}m` : "",
    bybitTotalPnl !== 0
      ? `Gross P/L (Bybit verified): ${bybitTotalPnl >= 0 ? "+" : ""}$${bybitTotalPnl.toFixed(2)} | Est. fees: ~$${estimatedFees.toFixed(2)}`
      : `Gross P/L: ${sign}$${input.pnl.toFixed(2)} | Est. fees: ~$${estimatedFees.toFixed(2)}`,
    `Net P/L: ${sign}${input.pnlPct.toFixed(2)}%`,
    ``,
    `Market context at entry:`,
    `- Regime (current): ${regime}`,
    `- Score at entry: ${input.score ?? "unknown"}/100`,
    `- Setup type: ${input.setupType ?? "unknown"}`,
    `- Why now: ${input.whyNow ?? input.reasoning ?? "unknown"}`,
    `- SL: ${input.sl ? "$" + parseFloat(input.sl).toFixed(4) : "not set"} | TP1: ${input.tp1 ? "$" + parseFloat(input.tp1).toFixed(4) : "not set"} | TP2: ${input.tp2 ? "$" + parseFloat(input.tp2).toFixed(4) : "not set"}`,
    ``,
    `Partial close history:`,
    partialsSection,
    ``,
    `Version B comparison (same symbol, same period):`,
    versionBStr,
    ``,
    `── Execution Analysis ──────────────────────────────`,
    `TP levels:`,
    `  TP1 ($${tp1Price > 0 ? tp1Price.toFixed(4) : "not set"}): reached=${tp1Reached ? "YES" : "NO"} | executed=${tp1Executed ? "YES" : "NO"}${tp1Price > 0 && tp1Reached && !tp1Executed ? " ⚠️ MISSED" : ""}`,
    `  TP2 ($${tp2Price > 0 ? tp2Price.toFixed(4) : "not set"}): reached=${tp2Reached ? "YES" : "NO"} | executed=${tp2Executed ? "YES" : "NO"}${tp2Price > 0 && tp2Reached && !tp2Executed ? " ⚠️ MISSED" : ""}`,
    ``,
    `Profit protection:`,
    `  Max profit during hold: ${maxProfitPct.toFixed(2)}%`,
    `  5% threshold: triggered=${maxProfitPct >= 5 ? "YES" : "NO"} | executed=${memPartials.some(p => p.partialType === "profit_5pct") ? "YES" : "NO"}`,
    `  10% threshold: triggered=${maxProfitPct >= 10 ? "YES" : "NO"} | executed=${memPartials.some(p => p.partialType === "profit_10pct") ? "YES" : "NO"}`,
    `  20% threshold: triggered=${maxProfitPct >= 20 ? "YES" : "NO"} | executed=${memPartials.some(p => p.partialType === "profit_20pct") ? "YES" : "NO"}`,
    ``,
    `Fill quality:`,
    `  Expected exit: $${expectedExitPrice.toFixed(4)}`,
    `  Actual exit:   $${actualExitPrice.toFixed(4)}`,
    `  Slippage:      ${slippage.toFixed(3)}%${slippage > 0.5 ? " ⚠️ SIGNIFICANT" : ""}`,
    ``,
    `Stop loss:`,
    `  Planned: $${plannedSL > 0 ? plannedSL.toFixed(4) : "not set"} | Direction: ${plannedSL > 0 ? (input.direction === "long" ? (plannedSL < input.entryPrice ? "correct (below entry)" : "WRONG (above entry)") : (plannedSL > input.entryPrice ? "correct (above entry)" : "WRONG (below entry)")) : "n/a"}`,
    ``,
    `Partial closes:`,
    `  Planned:   tp1, tp2`,
    `  Executed:  ${memPartials.length > 0 ? memPartials.map(p => `${p.partialType ?? "?"}@$${parseFloat(p.priceAtClose ?? "0").toFixed(4)}`).join(", ") : "none"}`,
    `  Unplanned: ${unplannedPartials.length > 0 ? unplannedPartials.map(p => p.partialType ?? "?").join(", ") : "none"}`,
    `  Total closes: ${memPartials.length}`,
    ``,
    `Exit method: ${exitMethod}`,
    `Execution issues: ${executionIssues.length > 0 ? executionIssues.join("; ") : "none"}`,
    `Failure type: ${failureType.toUpperCase()}`,
    ``,
    failureType === "execution"
      ? `IMPORTANT: Failure type is EXECUTION. Do NOT blame the strategy. Identify the specific system bug. What code fix is needed?`
      : failureType === "strategy"
      ? `IMPORTANT: Failure type is STRATEGY. What was wrong with the analysis? What signals were missed? What to do differently next time?`
      : failureType === "mixed"
      ? `IMPORTANT: Failure type is MIXED. Address both execution issues AND strategy quality.`
      : `IMPORTANT: Trade was successful. Focus on what worked well and reinforce good patterns.`,
    ``,
    `Reflect honestly. Be specific about named signals. No generic advice. Return ONLY valid JSON:`,
    `{"entryQuality":"good|ok|poor","directionCorrect":true,"entryTiming":"early|middle|late",`,
    `"slPlacement":"good|too_tight|too_wide","tpRealism":"good|too_tight|too_ambitious",`,
    `"sizingCorrect":true,"partialsCorrect":true,"marketContextCorrect":true,`,
    `"mistakeType":"wrong_direction|late_entry|stop_too_tight|stop_too_wide|chasing_extended_move|gave_back_profits|cut_winner_early|position_review_interference|stale_metadata_bug|correct_but_unlucky|null",`,
    `"signalsThatWorked":["specific signal name"],"signalsThatFailed":["specific signal name"],`,
    `"versionBLesson":"string or null","whatWorked":"string","whatDidnt":"string",`,
    `"lessonsLearned":"one concrete insight","nextTimeWouldDo":"one specific change"}`,
  ].filter(s => s !== null && s !== undefined).join("\n");

  type R = {
    entryQuality: string; directionCorrect: boolean; entryTiming: string;
    slPlacement: string; tpRealism: string; sizingCorrect: boolean;
    partialsCorrect: boolean | string; marketContextCorrect: boolean;
    mistakeType: string | null; signalsThatWorked: string[];
    signalsThatFailed: string[]; versionBLesson: string | null;
    whatWorked: string; whatDidnt: string; lessonsLearned: string; nextTimeWouldDo: string;
  };

  const res = await llm.json<R>({
    taskType:      "trade_reflection",
    systemContext: "You are a trading journal assistant. Reply JSON only. Be specific about signal names and prices. No markdown, no generic advice.",
    prompt,
    schema: {
      type: "object",
      required: ["entryQuality", "directionCorrect", "entryTiming", "slPlacement", "tpRealism",
                 "sizingCorrect", "partialsCorrect", "marketContextCorrect",
                 "signalsThatWorked", "signalsThatFailed", "whatWorked", "whatDidnt",
                 "lessonsLearned", "nextTimeWouldDo"],
      properties: {
        entryQuality:         { type: "string" },
        directionCorrect:     { type: "boolean" },
        entryTiming:          { type: "string" },
        slPlacement:          { type: "string" },
        tpRealism:            { type: "string" },
        sizingCorrect:        { type: "boolean" },
        partialsCorrect:      {},
        marketContextCorrect: { type: "boolean" },
        mistakeType:          {},
        signalsThatWorked:    { type: "array", items: { type: "string" } },
        signalsThatFailed:    { type: "array", items: { type: "string" } },
        versionBLesson:       {},
        whatWorked:           { type: "string" },
        whatDidnt:            { type: "string" },
        lessonsLearned:       { type: "string" },
        nextTimeWouldDo:      { type: "string" },
      },
    },
    fallback: {
      entryQuality: "ok", directionCorrect: true, entryTiming: "middle",
      slPlacement: "good", tpRealism: "good", sizingCorrect: true, partialsCorrect: "na",
      marketContextCorrect: true, mistakeType: null,
      signalsThatWorked: [], signalsThatFailed: [],
      versionBLesson: null, whatWorked: "", whatDidnt: "", lessonsLearned: "", nextTimeWouldDo: "",
    },
  });

  const d = res.data;
  const outcome    = input.pnl >= 0 ? "WIN" : "LOSS";
  const reflection = [
    `${input.direction.toUpperCase()} ${outcome} ${sign}${input.pnlPct.toFixed(2)}%`,
    d.mistakeType && d.mistakeType !== "null" ? `mistake=${d.mistakeType}` : null,
    d.lessonsLearned || null,
  ].filter(Boolean).join(" | ");

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
    // Execution quality tracking
    failureType,
    executionIssues,
    tp1Reached,
    tp2Reached,
    maxProfitPct:           String(maxProfitPct.toFixed(4)),
    profitProtectionMissed,
    slippagePct:            String(slippage.toFixed(4)),
    excessivePartials:      memPartials.length > 3,
    exitMethod,
    metadataWasStale:       false,
  });

  // Alert on execution failures
  if (executionIssues.length > 0 && _ruleAlertFn) {
    const resultLabel = tradeLost ? "LOSS" : "WIN";
    const msg = [
      `⚠️ <b>Execution issue — ${input.symbol}</b>`,
      `Issues: ${executionIssues.join(", ")}`,
      `Trade result: ${resultLabel} ${input.pnlPct >= 0 ? "+" : ""}${input.pnlPct.toFixed(2)}%`,
      ``,
      failureType === "execution"
        ? "Strategy was correct — system bug needs a fix"
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

  // Fix 2: Retry once after 60s if critical fields are missing
  if (!isComplete) {
    console.error(`[reflection] INCOMPLETE — ${input.symbol} missing critical fields. Scheduling retry in 60 seconds.`);
    setTimeout(() => {
      generateReflection(input).catch(e =>
        console.error(`[reflection] retry failed for ${input.symbol}:`, (e as Error).message)
      );
    }, 60_000);
  }
}

// ─── Partial close logger ─────────────────────────────────────────────────────

export async function logPartialClose(params: {
  symbol:       string;
  partialType:  "tp1" | "tp2" | "large_profit" | "review";
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

async function updateRuleStatsForTrade(won: boolean): Promise<void> {
  const rules = await getActiveRules();
  if (!rules.length) return;
  for (const rule of rules) {
    const update = won
      ? { winsFollowing: rule.winsFollowing + 1, updatedAt: new Date() }
      : { lossesFollowing: rule.lossesFollowing + 1, updatedAt: new Date() };
    await db.update(tradingRulesTable)
      .set(update)
      .where(eq(tradingRulesTable.id, rule.id))
      .catch(() => {});
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

export async function generateTradingRules(): Promise<void> {
  // Only generate if 20+ new closed trades since last generation
  const lastGenDate = await getLastRuleGenerationDate();
  const newTrades   = await db.select({ id: tradeLogTable.id })
    .from(tradeLogTable)
    .where(and(isNotNull(tradeLogTable.exitAt), gt(tradeLogTable.exitAt, lastGenDate)))
    .catch(() => [] as Array<{ id: string }>);

  if (newTrades.length < 20) {
    console.log(`[rules] Only ${newTrades.length}/20 new trades since last generation — skipping`);
    return;
  }

  const [reflections, existingRules] = await Promise.all([
    db.select()
      .from(tradeMemoryTable)
      .where(eq(tradeMemoryTable.action, "TRADE_CLOSE"))
      .orderBy(desc(tradeMemoryTable.createdAt))
      .limit(60)
      .catch(() => [] as typeof tradeMemoryTable.$inferSelect[]),
    getActiveRules(),
  ]);

  if (reflections.length < 10) {
    console.log(`[rules] Insufficient reflections (${reflections.length}) — skipping`);
    return;
  }

  // Separate execution failures from strategy failures
  const strategyReflections = reflections.filter(r =>
    !r.failureType || r.failureType === "strategy" || r.failureType === "success" || r.failureType === "mixed"
  );
  const executionOnlyFailures = reflections.filter(r => r.failureType === "execution");

  // Summarise execution failures
  const allExecIssues: string[] = [];
  for (const r of executionOnlyFailures) {
    if (Array.isArray(r.executionIssues)) allExecIssues.push(...(r.executionIssues as string[]));
  }
  const execIssueCounts: Record<string, number> = {};
  for (const issue of allExecIssues) execIssueCounts[issue] = (execIssueCounts[issue] ?? 0) + 1;
  const execSummary = Object.entries(execIssueCounts)
    .sort((a,b) => b[1]-a[1])
    .map(([issue, count]) => `  - ${issue}: ${count}x`)
    .join("\n") || "  none";

  const reflStr = strategyReflections.map(r => {
    const pct = parseFloat(r.pnlPct ?? "0");
    return [
      `${r.symbol} | P/L: ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
      r.entryQuality      ? `  Entry: ${r.entryQuality} timing=${r.entryTiming}` : "",
      r.mistakeType       ? `  Mistake: ${r.mistakeType}` : "",
      r.signalsThatWorked ? `  Worked: ${r.signalsThatWorked}` : "",
      r.signalsThatFailed ? `  Failed: ${r.signalsThatFailed}` : "",
      r.lessonsLearned    ? `  Lesson: ${r.lessonsLearned}` : "",
      r.nextTimeWouldDo   ? `  Next: ${r.nextTimeWouldDo}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n---\n");

  const existingStr = existingRules.map(r =>
    `Rule ${r.ruleNumber} [${r.confidence}]: ${r.ruleText}\n  Wins: ${r.winsFollowing} | Losses: ${r.lossesFollowing}`
  ).join("\n");

  const prompt = [
    `Analyse trade reflections and generate exactly 5 actionable trading rules.`,
    ``,
    `Execution-only failures excluded from rule generation (${executionOnlyFailures.length} trades):`,
    execSummary,
    `These need code fixes, not strategy rules.`,
    ``,
    `Analyse ONLY the ${strategyReflections.length} strategy/mixed/success entries below for rule generation:`,
    ``,
    `Requirements per rule:`,
    `- Minimum 3 trade occurrences as evidence`,
    `- Clear causal logic (not just correlation)`,
    `- Cross-check: funding positive = longs crowded = short bias; price above EMA = bullish; high volume breakout = real move`,
    `- Flag if rule contradicts market fundamentals`,
    `- Confidence: HIGH (5+ occurrences) | MEDIUM (3-4) | LOW (<3)`,
    ``,
    `Trade reflections (${strategyReflections.length} trades):`,
    reflStr,
    ``,
    existingRules.length ? `Current active rules:\n${existingStr}` : "No existing rules.",
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

  const res = await llm.json<RuleGenResult>({
    taskType:      "rule_generation",
    systemContext: "You are a trading performance analyst. Generate evidence-based rules from trade data. Reply JSON only.",
    prompt,
    schema: { type: "object", properties: { rules: { type: "array" }, patternsFound: { type: "string" } }, required: ["rules"] },
    fallback: { rules: [], patternsFound: "" },
  });

  let generated = 0;
  for (const rule of res.data.rules) {
    if (rule.occurrences < 3) {
      console.log(`[rules] Rule ${rule.ruleNumber} insufficient evidence (${rule.occurrences}<3) — skipped`);
      continue;
    }
    if (rule.contradictsFundamentals) {
      console.log(`[rules] Rule ${rule.ruleNumber} flags fundamentals contradiction: ${rule.flagNote ?? "unspecified"}`);
    }
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
      .onConflictDoUpdate({
        target: tradingRulesTable.ruleNumber,
        set: {
          ruleText:    rule.ruleText,
          evidence:    rule.evidence,
          causalLogic: rule.causalLogic,
          confidence:  rule.confidence,
          occurrences: rule.occurrences,
          active:      true,
          updatedAt:   new Date(),
        },
      })
      .catch(e => console.error(`[rules] Upsert rule ${rule.ruleNumber}:`, e));
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
    .where(eq(tradeMemoryTable.action, "TRADE_CLOSE"))
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
  const closedTrades = await db.select()
    .from(tradeLogTable)
    .where(isNotNull(tradeLogTable.exitAt))
    .orderBy(asc(tradeLogTable.entryAt))
    .catch(() => [] as Array<typeof tradeLogTable.$inferSelect>);

  let processed = 0;
  for (const trade of closedTrades) {
    if (processed >= max) break;

    // Deduplicate: skip only COMPLETE reflections (have lessonsLearned)
    const existingById = await db.select({ id: tradeMemoryTable.id })
      .from(tradeMemoryTable)
      .where(and(
        eq(tradeMemoryTable.sourceTradeId, trade.id),
        eq(tradeMemoryTable.action, "TRADE_CLOSE"),
        isNotNull(tradeMemoryTable.lessonsLearned),   // complete = has lessons
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
        isNotNull(tradeMemoryTable.lessonsLearned),   // complete = has lessons
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
      symbol:        trade.symbol,
      direction:     trade.direction,
      entryPrice,
      exitPrice,
      pnl,
      pnlPct,
      reasoning:     trade.reasoning ?? undefined,
      entryAt:       trade.entryAt,
      exitAt:        trade.exitAt,
      setupType:     trade.setupType,
      score:         trade.score,
      whyNow:        trade.whyNow,
      sl:            trade.sl,
      tp1:           trade.tp1,
      tp2:           trade.tp2,
      sourceTradeId: trade.id,
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
  const rows = await db.select({ pnl: tradeLogTable.pnl })
    .from(tradeLogTable)
    .where(isNotNull(tradeLogTable.exitAt));
  return rows.reduce((sum, r) => sum + parseFloat(r.pnl ?? "0"), 0);
}

export async function logOpenTrade(params: {
  symbol: string; broker: string; direction: "long" | "short";
  entryPrice: number; leverage: number; amountUsd: number; reasoning?: string;
  stopLoss?: number; takeProfit?: number; stopLossMethod?: string;
}): Promise<void> {
  const enriched = [
    params.reasoning,
    params.stopLoss       ? `SL=$${params.stopLoss}`          : null,
    params.takeProfit     ? `TP=$${params.takeProfit}`         : null,
    params.stopLossMethod ? `method=${params.stopLossMethod}`  : null,
  ].filter(Boolean).join(" | ");

  try {
    await db.insert(tradeLogTable).values({
      symbol:     params.symbol,
      broker:     params.broker,
      direction:  params.direction,
      entryPrice: String(params.entryPrice),
      amountUsd:  String(params.amountUsd),
      leverage:   params.leverage,
      reasoning:  enriched || null,
      entryAt:    new Date(),
    });
  } catch (e) {
    console.error("[tradeMemory] logOpenTrade failed:", e);
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
  }).catch(e => console.error("[tradeMemory] reflection failed:", e));

  // Rule tracking — update rule win/loss stats + resolve pending overrides
  updateRuleStatsForTrade(pnlPct > 0).catch(() => {});
  updatePendingOverrides(params.symbol, pnlPct).catch(() => {});
  checkAndGenerateRules().catch(() => {});
}
