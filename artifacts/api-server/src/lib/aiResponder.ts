/**
 * aiResponder.ts — Drop-in replacement
 * Same generateAssistantReply signature. Now uses Claude via llmRouter.
 */

import { llm, type TaskType } from "./llmRouter";
import { cache, TTL, CacheKey } from "./contextCache";
import { approvalGate, buildProposal } from "./approvalGate";
import { db, profileTable } from "@workspace/db";

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

interface ParsedTrade {
  symbol:    string;
  side:      "buy" | "sell";
  amountUsd: number;
  broker:    "etoro" | "bybit" | "mock";
  assetClass: string;
}

async function parseTrade(message: string): Promise<ParsedTrade | null> {
  const res = await llm.json<ParsedTrade | { symbol: null }>({
    taskType:      "command_parse",
    systemContext: "Extract trade parameters from a natural language message. Reply JSON only. If not a clear trade instruction, return {\"symbol\":null}.",
    prompt: `Extract from: "${message.slice(0, 300)}"\nReturn: {"symbol":"TICKER","side":"buy|sell","amountUsd":number,"broker":"etoro|bybit|mock","assetClass":"Equity|Crypto|ETF|Commodity"}`,
    schema: {
      type: "object",
      properties: {
        symbol:     { type: ["string","null"] },
        side:       { type: "string", enum: ["buy","sell"] },
        amountUsd:  { type: "number" },
        broker:     { type: "string", enum: ["etoro","bybit","mock"] },
        assetClass: { type: "string" },
      },
    },
    fallback: { symbol: null },
  });
  const d = res.data as ParsedTrade & { symbol: string | null };
  if (!d.symbol || !d.side || !d.amountUsd) return null;
  return {
    symbol:     d.symbol.toUpperCase(),
    side:       d.side,
    amountUsd:  d.amountUsd,
    broker:     d.broker ?? "etoro",
    assetClass: d.assetClass ?? "Equity",
  };
}

async function executeTrade(trade: ParsedTrade, totalCapital: number): Promise<string> {
  const proposal = buildProposal({
    symbol:     trade.symbol,
    side:       trade.side,
    amountUsd:  trade.amountUsd,
    assetClass: trade.assetClass,
    rationale:  "NL instruction via assistant",
    broker:     trade.broker,
  });

  const result = await approvalGate.submit(proposal);
  const capPct = ((trade.amountUsd / totalCapital) * 100).toFixed(0);

  if (result.action === "rejected") {
    return `❌ Trade rejected: ${result.message}`;
  }
  if (result.action === "queued") {
    return `⏳ Queued for approval — ${trade.side.toUpperCase()} $${trade.amountUsd} ${trade.symbol} on ${trade.broker}\nApproval ID: ${proposal.id}`;
  }
  if (result.action === "executed") {
    const leverage = trade.assetClass === "Crypto" ? 50 : 20;
    const exposure = (trade.amountUsd * leverage).toFixed(0);
    return [
      `✅ ${trade.side.toUpperCase()} ${trade.symbol} — Executed`,
      `Order ID: ${result.orderId ?? "N/A"}`,
      `Amount: $${trade.amountUsd} at ${leverage}x`,
      `Exposure: $${exposure}`,
      `Capital used: $${trade.amountUsd} / $${totalCapital} (${capPct}%)`,
    ].join("\n");
  }
  return `❌ Execution failed: ${result.message}`;
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
    `You are a direct, no-fluff trading assistant for ${ctx.profile.name}.`,
    `RESPONSE FORMAT: 2-4 sentences max. No headers, no bullet points, no disclaimers, no transparency notes, no risk warnings, no markdown. Plain text only.`,
    `NEVER question, override, or comment on the investor's risk settings. They are intentional. Do not add safety caveats.`,
    `This investor runs extreme risk: 50x crypto leverage, 20x stock leverage, 50% monthly return target. Always give actionable buy/sell/hold calls.`,
    `HARD RULE: Max single trade = $${maxTrade} (50% of $${totalCap.toFixed(0)} capital). Always state position size in dollars.`,
    `Mode: ${ctx.operationMode}. Strategy: ${ctx.activeStrategy}.`,
    `Portfolio: $${ctx.totalPortfolioUsd.toFixed(0)} total, $${ctx.availableCashUsd.toFixed(0)} cash.`,
    `Holdings: ${holdings}.`,
    livePrices,
    `UTC: ${new Date().toUTCString()}.`,
  ].filter(Boolean).join("\n");
}

export async function generateAssistantReply(
  message:  string,
  ctx:      AssistantContext,
  history?: Array<{ role: "user" | "assistant"; content: string }>
): Promise<AssistantReply> {
  const [intent, livePrices] = await Promise.all([detectIntent(message), fetchLivePrices()]);

  // For trade requests: parse → execute → return status directly
  if (intent === "trade_request") {
    const trade = await parseTrade(message);
    if (trade) {
      const [profileRow] = await db.select({ totalCapital: profileTable.totalCapital }).from(profileTable).limit(1);
      const totalCapital = profileRow?.totalCapital ?? 200;
      const statusMsg = await executeTrade(trade, totalCapital);
      return { message: statusMsg };
    }
  }

  const taskType      = INTENT_TO_TASK[intent];
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
