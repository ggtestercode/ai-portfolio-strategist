/**
 * aiResponder.ts — Drop-in replacement
 * Same generateAssistantReply signature. Now uses Claude via llmRouter.
 */

import { llm, type TaskType } from "./llmRouter";
import { cache, TTL, CacheKey } from "./contextCache";

export interface AssistantProfile {
  name:             string;
  riskTolerance:    "low" | "medium" | "high";
  investmentGoal:   string;
  monthlyBudgetUsd?: number;
}

export interface AssistantHolding {
  symbol:           string;
  assetClass:       string;
  currentValueUsd:  number;
  unrealisedPnlPct: number;
}

export interface AssistantContext {
  profile:              AssistantProfile;
  totalPortfolioUsd:    number;
  availableCashUsd:     number;
  holdings:             AssistantHolding[];
  targetAllocations:    Record<string, number>;
  activeStrategy:       string;
  rebalancingStatus:    "on_track" | "needs_rebalance";
  operationMode:        "autonomous" | "approval";
  approvalThresholdUsd: number;
}

export interface AssistantReply {
  message: string;
  _meta?: {
    model:            string;
    taskType:         string;
    estimatedCostUsd: number;
    cachedTokens:     number;
    latencyMs:        number;
  };
}

type Intent =
  | "simple_question" | "trade_request" | "strategy_request"
  | "rebalance_request" | "mode_change" | "risk_question" | "performance_query";

const INTENT_TO_TASK: Record<Intent, TaskType> = {
  simple_question:   "assistant_reply",
  trade_request:     "trade_decision",
  strategy_request:  "strategy_generation",
  rebalance_request: "rebalance_plan",
  mode_change:       "assistant_reply",
  risk_question:     "risk_alert",
  performance_query: "performance_analysis",
};

async function detectIntent(message: string): Promise<Intent> {
  const res = await llm.json<{ intent: Intent }>({
    taskType:      "command_parse",
    systemContext: "You classify trading assistant messages. Reply JSON only.",
    prompt:        `Classify intent: "${message.slice(0, 200)}"`,
    schema: {
      type: "object", required: ["intent"],
      properties: { intent: { type: "string",
        enum: ["simple_question","trade_request","strategy_request",
               "rebalance_request","mode_change","risk_question","performance_query"] } },
    },
    fallback: { intent: "simple_question" as Intent },
  });
  return res.data.intent;
}

async function fetchLivePrices(): Promise<string> {
  try {
    const symbols = "BTC-USD,ETH-USD,SOL-USD,AAPL,NVDA,MSFT";
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symbols}&range=1d&interval=1d`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return "";
    const data = await res.json() as {
      spark?: { result?: Array<{ symbol: string; response?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number } }> }> }
    };
    const results = data?.spark?.result ?? [];
    const parts = results.map(r => {
      const meta  = r.response?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const prev  = meta?.chartPreviousClose;
      if (!price) return null;
      const chgPct = prev ? (((price - prev) / prev) * 100).toFixed(1) : "0.0";
      const sign   = parseFloat(chgPct) >= 0 ? "+" : "";
      return `${r.symbol.replace("-USD","")} $${price.toLocaleString("en-US",{maximumFractionDigits:2})} (${sign}${chgPct}%)`;
    }).filter(Boolean);
    return parts.length ? `Live prices: ${parts.join(", ")}` : "";
  } catch {
    return "";
  }
}

function buildSystemPrompt(ctx: AssistantContext, livePrices: string): string {
  const holdings = ctx.holdings.length
    ? ctx.holdings.map(h =>
        `${h.symbol}($${h.currentValueUsd.toFixed(0)},${h.unrealisedPnlPct >= 0 ? "+" : ""}${h.unrealisedPnlPct.toFixed(1)}%)`
      ).join(" | ")
    : "none";
  const allocs = Object.entries(ctx.targetAllocations)
    .map(([k, v]) => `${k}:${v}%`).join(", ");
  const totalCap = ctx.totalPortfolioUsd > 0 ? ctx.totalPortfolioUsd : 200;
  const maxTrade = (totalCap * 0.5).toFixed(0);
  return [
    `You are an AI portfolio assistant for ${ctx.profile.name}.`,
    `This investor has EXTREME risk tolerance. They use leverage up to 50x on crypto and 20x on stocks.`,
    `Target is 50% return per month. Only suggest high-conviction momentum plays.`,
    `Never suggest conservative or defensive positions. Always include leverage recommendations in trade signals.`,
    `HARD RULE: Every trade must not exceed 50% of total capital ($${totalCap.toFixed(0)}). Maximum single trade = $${maxTrade}. Always state position size in dollar terms.`,
    `Risk: ${ctx.profile.riskTolerance}. Goal: ${ctx.profile.investmentGoal}.`,
    `Mode: ${ctx.operationMode} (approval threshold: $${ctx.approvalThresholdUsd}).`,
    `Strategy: ${ctx.activeStrategy} | Status: ${ctx.rebalancingStatus}.`,
    `Portfolio: $${ctx.totalPortfolioUsd.toFixed(0)} total, $${ctx.availableCashUsd.toFixed(0)} cash.`,
    `Holdings: ${holdings}.`,
    `Target allocation: ${allocs}.`,
    livePrices,
    `UTC now: ${new Date().toUTCString()}.`,
    `Be concise. Cite data timestamps.`,
  ].filter(Boolean).join("\n");
}

export async function generateAssistantReply(
  message:  string,
  ctx:      AssistantContext,
  history?: Array<{ role: "user" | "assistant"; content: string }>
): Promise<AssistantReply> {
  const [intent, livePrices] = await Promise.all([detectIntent(message), fetchLivePrices()]);
  const taskType    = INTENT_TO_TASK[intent];
  const systemContext = buildSystemPrompt(ctx, livePrices);
  const res = await llm.chat({ taskType, userMessage: message, systemContext, history });
  return {
    message: res.text,
    _meta: {
      model:            res.model,
      taskType:         res.taskType,
      estimatedCostUsd: res.estimatedCostUsd,
      cachedTokens:     res.cachedTokens,
      latencyMs:        res.latencyMs,
    },
  };
}

export async function getCachedContext(
  fetcher: () => Promise<AssistantContext>
): Promise<AssistantContext> {
  return cache.get(CacheKey.portfolio(), TTL.PORTFOLIO, fetcher);
}
