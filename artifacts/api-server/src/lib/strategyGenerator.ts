import { openai } from "@workspace/integrations-openai-ai-server";
import type { StrategyPick } from "@workspace/db";
import { getProfile } from "./profile";
import { logger } from "./logger";

const MODEL = "gpt-5.4";

export type GeneratedOption = {
  name: string;
  summary: string;
  riskLevel: "Low" | "Medium" | "High";
  expectedReturnPct: number;
  picks: StrategyPick[];
};

const ALLOWED_ASSET_CLASSES = [
  "Crypto",
  "Equities",
  "ETFs",
  "Cash",
  "Commodities",
  "Bonds",
];
const ALLOWED_RISK_LEVELS = ["Low", "Medium", "High"];

function normalizeOption(opt: GeneratedOption, idx: number): GeneratedOption {
  const picks = (opt.picks ?? [])
    .filter((p) => p && typeof p.symbol === "string")
    .map((p) => ({
      symbol: String(p.symbol).toUpperCase().slice(0, 12),
      name: String(p.name ?? p.symbol),
      assetClass: ALLOWED_ASSET_CLASSES.includes(p.assetClass)
        ? p.assetClass
        : "Equities",
      weightPct: Math.max(0, Number(p.weightPct) || 0),
      rationale: String(p.rationale ?? "").slice(0, 240),
    }));
  const sum = picks.reduce((s, p) => s + p.weightPct, 0);
  if (sum > 0 && Math.abs(sum - 100) > 0.5) {
    for (const p of picks) {
      p.weightPct = Math.round(((p.weightPct / sum) * 100) * 10) / 10;
    }
  }
  return {
    name: String(opt.name ?? `Option ${idx + 1}`).slice(0, 60),
    summary: String(opt.summary ?? "").slice(0, 320),
    riskLevel: ALLOWED_RISK_LEVELS.includes(opt.riskLevel)
      ? opt.riskLevel
      : "Medium",
    expectedReturnPct: Math.max(
      0,
      Math.min(80, Number(opt.expectedReturnPct) || 0),
    ),
    picks,
  };
}

function fallbackOptions(): GeneratedOption[] {
  return [
    {
      name: "Capital Preservation",
      summary:
        "Defensive mix anchored in cash, dividend equities and gold to protect downside.",
      riskLevel: "Low",
      expectedReturnPct: 7,
      picks: [
        { symbol: "VOO", name: "Vanguard S&P 500 ETF", assetClass: "ETFs", weightPct: 25, rationale: "Broad equity exposure with low fees." },
        { symbol: "BND", name: "Vanguard Total Bond ETF", assetClass: "Bonds", weightPct: 25, rationale: "Steady fixed-income ballast." },
        { symbol: "GLD", name: "SPDR Gold Trust", assetClass: "Commodities", weightPct: 15, rationale: "Inflation and tail-risk hedge." },
        { symbol: "USD", name: "Cash Reserve", assetClass: "Cash", weightPct: 25, rationale: "Dry powder for drawdowns." },
        { symbol: "BTC", name: "Bitcoin", assetClass: "Crypto", weightPct: 10, rationale: "Small asymmetric crypto sleeve." },
      ],
    },
    {
      name: "Balanced Growth",
      summary:
        "Diversified blend of mega-cap equities, blue-chip crypto and ETFs for steady compounding.",
      riskLevel: "Medium",
      expectedReturnPct: 18,
      picks: [
        { symbol: "BTC", name: "Bitcoin", assetClass: "Crypto", weightPct: 25, rationale: "Core crypto allocation." },
        { symbol: "ETH", name: "Ethereum", assetClass: "Crypto", weightPct: 15, rationale: "Smart-contract platform leader." },
        { symbol: "NVDA", name: "NVIDIA", assetClass: "Equities", weightPct: 15, rationale: "AI compute backbone." },
        { symbol: "AAPL", name: "Apple", assetClass: "Equities", weightPct: 10, rationale: "Cash-rich consumer tech anchor." },
        { symbol: "VOO", name: "Vanguard S&P 500 ETF", assetClass: "ETFs", weightPct: 20, rationale: "Broad market exposure." },
        { symbol: "USD", name: "Cash Reserve", assetClass: "Cash", weightPct: 10, rationale: "Liquidity for opportunities." },
        { symbol: "GLD", name: "SPDR Gold Trust", assetClass: "Commodities", weightPct: 5, rationale: "Diversifier." },
      ],
    },
    {
      name: "Aggressive Growth",
      summary:
        "High-conviction crypto and innovation equities targeting outsized upside.",
      riskLevel: "High",
      expectedReturnPct: 32,
      picks: [
        { symbol: "BTC", name: "Bitcoin", assetClass: "Crypto", weightPct: 30, rationale: "Largest digital store of value." },
        { symbol: "ETH", name: "Ethereum", assetClass: "Crypto", weightPct: 20, rationale: "Layer-1 settlement leader." },
        { symbol: "SOL", name: "Solana", assetClass: "Crypto", weightPct: 10, rationale: "High-throughput challenger chain." },
        { symbol: "NVDA", name: "NVIDIA", assetClass: "Equities", weightPct: 15, rationale: "AI compute monopoly." },
        { symbol: "TSLA", name: "Tesla", assetClass: "Equities", weightPct: 10, rationale: "EV and robotics optionality." },
        { symbol: "QQQ", name: "Invesco QQQ Trust", assetClass: "ETFs", weightPct: 10, rationale: "Concentrated tech beta." },
        { symbol: "USD", name: "Cash Reserve", assetClass: "Cash", weightPct: 5, rationale: "Tactical reserve." },
      ],
    },
  ];
}

export async function generateStrategyOptions(): Promise<GeneratedOption[]> {
  const profile = await getProfile();

  const userPrompt = [
    `Investor goals:`,
    `- Total capital: $${profile.totalCapital.toLocaleString()}`,
    `- Target annual return: ${profile.targetReturnPct}%`,
    `- Time horizon: ${profile.timeHorizonMonths} months`,
    `- Stated risk tolerance: ${profile.riskTolerance}`,
    ``,
    `Generate three distinct portfolio strategy options spanning Low, Medium and High risk levels.`,
    `Each option must contain 5-8 specific holdings using REAL ticker symbols (e.g. BTC, ETH, SOL, AAPL, MSFT, NVDA, TSLA, GOOG, VOO, QQQ, SPY, BND, GLD, USD).`,
    `Each pick's assetClass must be one of: Crypto, Equities, ETFs, Bonds, Commodities, Cash.`,
    `Weights within an option must sum to exactly 100. Provide a one-sentence rationale per pick.`,
  ].join("\n");

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 8192,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "strategy_options",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["options"],
            properties: {
              options: {
                type: "array",
                minItems: 3,
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "name",
                    "summary",
                    "riskLevel",
                    "expectedReturnPct",
                    "picks",
                  ],
                  properties: {
                    name: { type: "string" },
                    summary: { type: "string" },
                    riskLevel: {
                      type: "string",
                      enum: ["Low", "Medium", "High"],
                    },
                    expectedReturnPct: { type: "number" },
                    picks: {
                      type: "array",
                      minItems: 5,
                      maxItems: 8,
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: [
                          "symbol",
                          "name",
                          "assetClass",
                          "weightPct",
                          "rationale",
                        ],
                        properties: {
                          symbol: { type: "string" },
                          name: { type: "string" },
                          assetClass: {
                            type: "string",
                            enum: [
                              "Crypto",
                              "Equities",
                              "ETFs",
                              "Bonds",
                              "Commodities",
                              "Cash",
                            ],
                          },
                          weightPct: { type: "number" },
                          rationale: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "You are a senior multi-asset portfolio strategist. Always return strict JSON matching the requested schema.",
        },
        { role: "user", content: userPrompt },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error("Empty model response");
    const parsed = JSON.parse(raw) as { options: GeneratedOption[] };
    if (!Array.isArray(parsed.options) || parsed.options.length < 3) {
      throw new Error("Model returned fewer than 3 options");
    }
    return parsed.options.slice(0, 3).map(normalizeOption);
  } catch (err) {
    logger.error({ err }, "generateStrategyOptions failed, using fallback");
    return fallbackOptions().map(normalizeOption);
  }
}
