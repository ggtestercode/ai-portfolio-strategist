/**
 * strategyGenerator.ts — Token-efficient strategy generation
 * Types match DB schema (strategyOptions.ts) exactly.
 */

import { llm }                  from "./llmRouter";
import { cache, TTL, CacheKey } from "./contextCache";

// Matches lib/db/src/schema/strategyOptions.ts StrategyPick exactly
export interface StrategyPick {
  symbol:     string;
  name:       string;
  assetClass: string;
  weightPct:  number;
  rationale:  string;
}

export interface StrategyOption {
  name:              string;
  riskLevel:         string;
  expectedReturnPct: number;
  summary:           string;
  picks:             StrategyPick[];
  generatedAt:       string;
}

export interface StrategyResult {
  options:          StrategyOption[];
  recommendedIndex: number;
  fromCache:        boolean;
  generatedAt:      string;
}

export interface GenerateStrategyParams {
  riskTolerance:     "low" | "medium" | "high";
  investmentGoalUsd?: number;
  currentHoldings?:  string[];
  monthlyBudgetUsd?: number;
  forceRefresh?:     boolean;
}

const SCHEMA = {
  type: "object", required: ["options","recommendedIndex"],
  properties: {
    recommendedIndex: { type: "number" },
    options: {
      type: "array", minItems: 3, maxItems: 3,
      items: {
        type: "object",
        required: ["name","riskLevel","expectedReturnPct","summary","picks"],
        properties: {
          name:              { type: "string" },
          riskLevel:         { type: "string", enum: ["low","medium","high"] },
          expectedReturnPct: { type: "number" },
          summary:           { type: "string" },
          picks: {
            type: "array", minItems: 5, maxItems: 8,
            items: {
              type: "object",
              required: ["symbol","name","assetClass","weightPct","rationale"],
              properties: {
                symbol:     { type: "string" },
                name:       { type: "string" },
                assetClass: { type: "string" },
                weightPct:  { type: "number", minimum: 1, maximum: 100 },
                rationale:  { type: "string" },
              }
            }
          }
        }
      }
    }
  }
};

function buildFallback(): Pick<StrategyResult,"options"|"recommendedIndex"> {
  const now = new Date().toISOString();
  return {
    recommendedIndex: 1,
    options: [
      {
        name: "Capital Preservation", riskLevel: "low",
        expectedReturnPct: 6.5,
        summary: "Defensive allocation. Dividend ETFs, T-bills, gold. Minimal crypto.",
        generatedAt: now,
        picks: [
          { symbol:"VTI",  name:"Vanguard Total Stock Market ETF", assetClass:"ETF",       weightPct:40, rationale:"Broad US market, low cost" },
          { symbol:"SGOV", name:"iShares 0-3 Month Treasury ETF",  assetClass:"ETF",       weightPct:25, rationale:"Short-term T-bills yield" },
          { symbol:"GLD",  name:"SPDR Gold Shares",                assetClass:"Commodity", weightPct:15, rationale:"Inflation hedge" },
          { symbol:"VNQ",  name:"Vanguard Real Estate ETF",        assetClass:"REIT",      weightPct:10, rationale:"Real estate income" },
          { symbol:"BTC",  name:"Bitcoin",                         assetClass:"Crypto",    weightPct:10, rationale:"Small digital asset exposure" },
        ],
      },
      {
        name: "Balanced Growth", riskLevel: "medium",
        expectedReturnPct: 14,
        summary: "Quality equities and crypto with ETF diversification.",
        generatedAt: now,
        picks: [
          { symbol:"NVDA", name:"NVIDIA Corporation",      assetClass:"US Equity", weightPct:20, rationale:"AI infrastructure leader" },
          { symbol:"MSFT", name:"Microsoft Corporation",   assetClass:"US Equity", weightPct:15, rationale:"Stable cloud growth" },
          { symbol:"QQQ",  name:"Invesco QQQ Trust",       assetClass:"ETF",       weightPct:15, rationale:"NASDAQ broad coverage" },
          { symbol:"BTC",  name:"Bitcoin",                 assetClass:"Crypto",    weightPct:25, rationale:"Digital store of value" },
          { symbol:"ETH",  name:"Ethereum",                assetClass:"Crypto",    weightPct:15, rationale:"Smart contract ecosystem" },
          { symbol:"GLD",  name:"SPDR Gold Shares",        assetClass:"Commodity", weightPct:10, rationale:"Portfolio anchor" },
        ],
      },
      {
        name: "Aggressive Alpha", riskLevel: "high",
        expectedReturnPct: 30,
        summary: "Concentrated crypto and growth equities. High drawdown risk.",
        generatedAt: now,
        picks: [
          { symbol:"BTC",  name:"Bitcoin",           assetClass:"Crypto",    weightPct:30, rationale:"Dominant crypto by market cap" },
          { symbol:"ETH",  name:"Ethereum",          assetClass:"Crypto",    weightPct:20, rationale:"DeFi and L2 hub" },
          { symbol:"SOL",  name:"Solana",            assetClass:"Crypto",    weightPct:15, rationale:"High-throughput L1 ecosystem" },
          { symbol:"NVDA", name:"NVIDIA Corporation",assetClass:"US Equity", weightPct:20, rationale:"AI compute monopoly" },
          { symbol:"PLTR", name:"Palantir Technologies", assetClass:"US Equity", weightPct:10, rationale:"AI data platform" },
          { symbol:"ARKK", name:"ARK Innovation ETF",   assetClass:"ETF",       weightPct:5,  rationale:"Disruptive tech basket" },
        ],
      },
    ],
  };
}

function normaliseWeights(picks: StrategyPick[]): StrategyPick[] {
  const total = picks.reduce((s, p) => s + p.weightPct, 0);
  if (Math.abs(total - 100) < 0.5) return picks;
  return picks.map(p => ({ ...p, weightPct: parseFloat(((p.weightPct / total) * 100).toFixed(1)) }));
}

export async function generateStrategyOptions(
  params: GenerateStrategyParams
): Promise<StrategyResult> {
  const riskToIdx: Record<string, number> = { low: 0, medium: 1, high: 2 };
  const cacheKey = CacheKey.strategyOptions();

  if (!params.forceRefresh) {
    const stored = (cache as any).getStore().get(cacheKey);
    if (stored && Date.now() < stored.expiresAt) {
      return { ...(stored.data as StrategyResult), fromCache: true };
    }
  }

  const now = new Date().toISOString();

  const systemContext = [
    "You are a portfolio strategist. Generate exactly 3 investment strategy options.",
    "Return only valid JSON. No markdown fences, no backticks, no explanation outside the JSON object.",
    "Use real tickers only. weightPct per option must sum to 100.",
    "Each pick needs: symbol, name (full company/fund name), assetClass, weightPct (number), rationale (1 sentence).",
    "expectedReturnPct must be a number (e.g. 12.5 not '12.5%').",
    "Summary max 2 sentences. Diversify across asset classes.",
    `Today: ${new Date().toUTCString()}.`,
  ].join(" ");

  const prompt = [
    `Generate 3 strategies (low/medium/high risk) for ${params.riskTolerance} risk investor.`,
    params.investmentGoalUsd ? `Goal: $${params.investmentGoalUsd.toLocaleString()}.` : "",
    params.monthlyBudgetUsd  ? `Monthly budget: $${params.monthlyBudgetUsd}.` : "",
    params.currentHoldings?.length ? `Current holdings: ${params.currentHoldings.join(", ")}.` : "",
    `recommendedIndex: ${riskToIdx[params.riskTolerance]}.`,
    `Return only valid JSON. No markdown fences, no backticks, no explanation outside the JSON object.`,
  ].filter(Boolean).join(" ");

  const res = await llm.json<Pick<StrategyResult,"options"|"recommendedIndex">>({
    taskType: "strategy_generation",
    systemContext, prompt,
    schema:   SCHEMA,
    fallback: buildFallback(),
  });

  const options: StrategyOption[] = res.data.options.map(opt => ({
    ...opt,
    expectedReturnPct: typeof opt.expectedReturnPct === "number"
      ? opt.expectedReturnPct
      : parseFloat(String(opt.expectedReturnPct)) || 0,
    generatedAt: now,
    picks: normaliseWeights(opt.picks),
  }));

  const result: StrategyResult = {
    options,
    recommendedIndex: res.data.recommendedIndex ?? riskToIdx[params.riskTolerance],
    fromCache: false,
    generatedAt: now,
  };

  await cache.get(cacheKey, TTL.STRATEGY_OPTIONS, async () => result);
  return result;
}
