import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, profileTable, targetAllocationsTable } from "@workspace/db";
import {
  GetCurrentStrategyResponse,
  RegenerateStrategyResponse,
} from "@workspace/api-zod";
import { getProfile } from "../lib/profile";

const router: IRouter = Router();

async function buildStrategy() {
  const profile = await getProfile();
  const targets = await db.select().from(targetAllocationsTable);
  return {
    strategyType: profile.strategyType,
    lastGenerated: profile.strategyLastGenerated.toISOString(),
    riskLevel: profile.strategyRiskLevel,
    allocation: targets
      .map((t) => ({ assetClass: t.assetClass, percentage: t.targetPct }))
      .sort((a, b) => b.percentage - a.percentage),
    keyRules: profile.strategyKeyRules,
  };
}

const STRATEGY_VARIANTS: Array<{
  riskLevel: "Low" | "Medium" | "High";
  type: string;
  allocation: Array<{ assetClass: string; targetPct: number }>;
  rules: string[];
}> = [
  {
    riskLevel: "Low",
    type: "Capital Preservation",
    allocation: [
      { assetClass: "Equities", targetPct: 25 },
      { assetClass: "ETFs", targetPct: 20 },
      { assetClass: "Cash", targetPct: 30 },
      { assetClass: "Crypto", targetPct: 5 },
      { assetClass: "Commodities", targetPct: 20 },
    ],
    rules: [
      "Maintain target allocation within ±3%",
      "Max position size: 10%",
      "Max drawdown: 8%",
      "Rebalance when deviation > 4%",
    ],
  },
  {
    riskLevel: "Medium",
    type: "Balanced Growth",
    allocation: [
      { assetClass: "Crypto", targetPct: 40 },
      { assetClass: "Equities", targetPct: 30 },
      { assetClass: "ETFs", targetPct: 15 },
      { assetClass: "Cash", targetPct: 10 },
      { assetClass: "Commodities", targetPct: 5 },
    ],
    rules: [
      "Maintain target allocation within ±5%",
      "Max position size: 20%",
      "Max drawdown: 15%",
      "Rebalance when deviation > 5%",
    ],
  },
  {
    riskLevel: "High",
    type: "Aggressive Growth",
    allocation: [
      { assetClass: "Crypto", targetPct: 55 },
      { assetClass: "Equities", targetPct: 25 },
      { assetClass: "ETFs", targetPct: 10 },
      { assetClass: "Cash", targetPct: 5 },
      { assetClass: "Commodities", targetPct: 5 },
    ],
    rules: [
      "Maintain target allocation within ±7%",
      "Max position size: 30%",
      "Max drawdown: 25%",
      "Rebalance when deviation > 7%",
    ],
  },
];

router.get("/strategy", async (_req, res): Promise<void> => {
  res.json(GetCurrentStrategyResponse.parse(await buildStrategy()));
});

router.post("/strategy/regenerate", async (_req, res): Promise<void> => {
  const profile = await getProfile();
  const variant =
    STRATEGY_VARIANTS.find((v) => v.riskLevel === profile.riskTolerance) ??
    STRATEGY_VARIANTS[1]!;
  await db
    .update(profileTable)
    .set({
      strategyType: variant.type,
      strategyRiskLevel: variant.riskLevel,
      strategyKeyRules: variant.rules,
      strategyLastGenerated: new Date(),
    })
    .where(eq(profileTable.id, profile.id));

  await db.delete(targetAllocationsTable);
  if (variant.allocation.length > 0) {
    await db.insert(targetAllocationsTable).values(variant.allocation);
  }

  res.json(RegenerateStrategyResponse.parse(await buildStrategy()));
});

export default router;
