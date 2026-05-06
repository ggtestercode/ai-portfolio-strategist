import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import {
  db,
  profileTable,
  targetAllocationsTable,
  strategyOptionsTable,
} from "@workspace/db";
import {
  GetCurrentStrategyResponse,
  RegenerateStrategyResponse,
  GetStrategyOptionsResponse,
  ApplyStrategyOptionsBody,
  ApplyStrategyOptionsResponse,
} from "@workspace/api-zod";
import { getProfile } from "../lib/profile";
import { generateStrategyOptions } from "../lib/strategyGenerator";

const router: IRouter = Router();

function titleCase(s: string | null | undefined): string {
  if (!s) return "Medium";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

async function buildStrategy() {
  const profile = await getProfile();
  const targets = await db.select().from(targetAllocationsTable);
  return {
    strategyType: profile.strategyType,
    lastGenerated: profile.strategyLastGenerated.toISOString(),
    riskLevel: titleCase(profile.strategyRiskLevel),
    allocation: targets
      .map((t) => ({ assetClass: t.assetClass, percentage: t.targetPct }))
      .sort((a, b) => b.percentage - a.percentage),
    keyRules: profile.strategyKeyRules,
  };
}

function serializeOption(o: typeof strategyOptionsTable.$inferSelect) {
  return {
    id: o.id,
    optionIndex: o.optionIndex,
    name: o.name,
    summary: o.summary,
    riskLevel: titleCase(o.riskLevel),
    expectedReturnPct: o.expectedReturnPct,
    picks: o.picks,
    generatedAt: o.generatedAt.toISOString(),
  };
}

function rulesForRisk(riskLevel: string): string[] {
  if (riskLevel === "Low") {
    return [
      "Maintain target allocation within ±3%",
      "Max position size: 10%",
      "Max drawdown: 8%",
      "Rebalance when deviation > 4%",
    ];
  }
  if (riskLevel === "High") {
    return [
      "Maintain target allocation within ±7%",
      "Max position size: 30%",
      "Max drawdown: 25%",
      "Rebalance when deviation > 7%",
    ];
  }
  return [
    "Maintain target allocation within ±5%",
    "Max position size: 20%",
    "Max drawdown: 15%",
    "Rebalance when deviation > 5%",
  ];
}

router.get("/strategy", async (_req, res): Promise<void> => {
  res.json(GetCurrentStrategyResponse.parse(await buildStrategy()));
});

router.get("/strategy/options", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(strategyOptionsTable)
    .orderBy(asc(strategyOptionsTable.optionIndex));
  res.json(GetStrategyOptionsResponse.parse(rows.map(serializeOption)));
});

router.post("/strategy/regenerate", async (req, res): Promise<void> => {
  const profile = await getProfile();
  const result = await generateStrategyOptions({
    riskTolerance: (profile?.riskTolerance ?? "medium") as "low" | "medium" | "high",
    forceRefresh: false,
  });
  const options = result.options;

  await db.delete(strategyOptionsTable);
  const inserted = await db
    .insert(strategyOptionsTable)
    .values(
      options.map((o, idx) => ({
        optionIndex: idx,
        name: o.name,
        summary: o.summary,
        riskLevel: o.riskLevel,
        expectedReturnPct: o.expectedReturnPct,
        picks: o.picks,
      })),
    )
    .returning();

  // Pick the option that matches the user's stated risk tolerance, fall back to medium.
  const chosen =
    options.find((o) => o.riskLevel === profile.riskTolerance) ??
    options[1] ??
    options[0]!;

  // Aggregate picks by asset class for active allocation.
  const byClass: Record<string, number> = {};
  for (const pick of chosen.picks) {
    byClass[pick.assetClass] = (byClass[pick.assetClass] ?? 0) + pick.weightPct;
  }
  const allocation = Object.entries(byClass).map(([assetClass, targetPct]) => ({
    assetClass,
    targetPct: Math.round(targetPct * 10) / 10,
  }));

  await db
    .update(profileTable)
    .set({
      strategyType: chosen.name,
      strategyRiskLevel: chosen.riskLevel,
      strategyKeyRules: rulesForRisk(String(chosen.riskLevel)),
      strategyLastGenerated: new Date(),
    })
    .where(eq(profileTable.id, profile.id));

  await db.delete(targetAllocationsTable);
  if (allocation.length > 0) {
    await db.insert(targetAllocationsTable).values(allocation);
  }

  res.json(
    RegenerateStrategyResponse.parse({
      strategy: await buildStrategy(),
      options: inserted.map(serializeOption),
    }),
  );
});

router.post("/strategy/options/apply", async (req, res): Promise<void> => {
  const parsed = ApplyStrategyOptionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { strategyName, picks } = parsed.data;
  if (picks.length === 0) {
    res.status(400).json({ error: "Select at least one pick" });
    return;
  }

  // Normalize weights to 100%.
  const totalWeight = picks.reduce((s, p) => s + p.weightPct, 0);
  if (totalWeight <= 0) {
    res.status(400).json({ error: "Selected picks must have positive weight" });
    return;
  }
  const normalized = picks.map((p) => ({
    ...p,
    weightPct: (p.weightPct / totalWeight) * 100,
  }));

  // Aggregate by asset class.
  const byClass: Record<string, number> = {};
  for (const p of normalized) {
    byClass[p.assetClass] = (byClass[p.assetClass] ?? 0) + p.weightPct;
  }
  const allocation = Object.entries(byClass).map(([assetClass, targetPct]) => ({
    assetClass,
    targetPct: Math.round(targetPct * 10) / 10,
  }));

  // Determine risk level from concentration.
  const cryptoPct = byClass["Crypto"] ?? 0;
  const cashPct = (byClass["Cash"] ?? 0) + (byClass["Bonds"] ?? 0);
  const riskLevel: "Low" | "Medium" | "High" =
    cryptoPct >= 45 ? "High" : cashPct >= 30 ? "Low" : "Medium";

  const profile = await getProfile();
  await db
    .update(profileTable)
    .set({
      strategyType: strategyName,
      strategyRiskLevel: riskLevel,
      strategyKeyRules: rulesForRisk(riskLevel),
      strategyLastGenerated: new Date(),
    })
    .where(eq(profileTable.id, profile.id));

  await db.delete(targetAllocationsTable);
  if (allocation.length > 0) {
    await db.insert(targetAllocationsTable).values(allocation);
  }

  res.json(ApplyStrategyOptionsResponse.parse(await buildStrategy()));
});

export default router;
