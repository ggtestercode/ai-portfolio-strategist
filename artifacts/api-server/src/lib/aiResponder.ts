import { openai } from "@workspace/integrations-openai-ai-server";
import { getProfile } from "./profile";
import {
  getPortfolioSnapshot,
  getAllocationRows,
  getRebalancingActions,
} from "./portfolio";
import { logger } from "./logger";

const MODEL = "gpt-5.4";

const fmtUsd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

const fmtPct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

async function buildPortfolioContext(): Promise<string> {
  const profile = await getProfile();
  const snap = await getPortfolioSnapshot(profile.totalCapital);
  const allocation = await getAllocationRows();
  const rebal = await getRebalancingActions();

  const allocationLines = allocation
    .map(
      (a) =>
        `  - ${a.assetClass}: ${a.currentPct.toFixed(1)}% current vs ${a.targetPct.toFixed(1)}% target (${a.status})`,
    )
    .join("\n");

  const rebalLines =
    rebal.length === 0
      ? "  (none — allocation within target bands)"
      : rebal
          .map((r) => `  - ${r.actionType} ${fmtUsd(r.amount)} of ${r.asset}`)
          .join("\n");

  return [
    `Investor profile:`,
    `  Name: ${profile.name}`,
    `  Total capital: ${fmtUsd(profile.totalCapital)}`,
    `  Target return: ${profile.targetReturnPct}% over ${profile.timeHorizonMonths} months`,
    `  Risk tolerance: ${profile.riskTolerance}`,
    `Active strategy: "${profile.strategyType}" (${profile.strategyRiskLevel} risk)`,
    `Strategy rules:`,
    ...profile.strategyKeyRules.map((r) => `  - ${r}`),
    ``,
    `Portfolio snapshot:`,
    `  Total value: ${fmtUsd(snap.totalValue)}`,
    `  Total P/L: ${fmtUsd(snap.totalProfitLoss)} (${fmtPct(snap.totalProfitLossPct)})`,
    `  24h change: ${fmtUsd(snap.change24h)} (${fmtPct(snap.change24hPct)})`,
    ``,
    `Allocation vs target:`,
    allocationLines,
    ``,
    `Pending rebalancing actions:`,
    rebalLines,
  ].join("\n");
}

export async function generateAssistantReply(prompt: string): Promise<string> {
  try {
    const context = await buildPortfolioContext();
    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 8192,
      messages: [
        {
          role: "system",
          content: [
            "You are an AI portfolio strategist embedded in a sophisticated investment dashboard.",
            "Always answer in 2-5 short sentences using the data provided. Be specific and reference dollar amounts, percentages, and asset names from the context.",
            "Never invent data the context does not contain. If the user asks for something outside the dashboard, briefly say so and recommend an in-app action.",
            "Do not use markdown headings or bullet symbols other than '-'. Do not use emojis.",
            "",
            "Live portfolio context:",
            context,
          ].join("\n"),
        },
        { role: "user", content: prompt },
      ],
    });
    const reply = completion.choices[0]?.message?.content?.trim();
    if (reply) return reply;
    throw new Error("Empty reply from model");
  } catch (err) {
    logger.error({ err }, "generateAssistantReply failed, using fallback");
    return fallbackReply(prompt);
  }
}

async function fallbackReply(prompt: string): Promise<string> {
  const profile = await getProfile();
  const snap = await getPortfolioSnapshot(profile.totalCapital);
  return `Your "${profile.strategyType}" strategy is active. Portfolio is ${fmtUsd(
    snap.totalValue,
  )} with ${fmtPct(snap.totalProfitLossPct)} total return and ${fmtPct(
    snap.change24hPct,
  )} today. (Couldn't reach the live model — please retry: "${prompt.slice(0, 60)}".)`;
}
