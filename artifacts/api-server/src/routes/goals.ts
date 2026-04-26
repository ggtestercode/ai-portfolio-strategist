import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, profileTable } from "@workspace/db";
import {
  GetInvestmentGoalsResponse,
  UpdateInvestmentGoalsResponse,
  UpdateInvestmentGoalsBody,
} from "@workspace/api-zod";
import { getProfile } from "../lib/profile";
import { getPortfolioSnapshot } from "../lib/portfolio";

const router: IRouter = Router();

async function buildGoals(profile: { totalCapital: number; targetReturnPct: number; timeHorizonMonths: number; riskTolerance: string }) {
  const snapshot = await getPortfolioSnapshot(profile.totalCapital);
  const targetValue = profile.totalCapital * (1 + profile.targetReturnPct / 100);
  const goalProgressPct =
    targetValue > profile.totalCapital
      ? Math.max(0, Math.min(100, ((snapshot.totalValue - profile.totalCapital) /
        (targetValue - profile.totalCapital)) * 100))
      : 0;
  const goalProgressNote =
    goalProgressPct >= 60
      ? "You are on track to achieve your target return."
      : goalProgressPct >= 30
        ? "Solid progress — keep monitoring volatility."
        : "Consider reviewing your strategy to accelerate progress.";

  return {
    totalCapital: profile.totalCapital,
    targetReturnPct: profile.targetReturnPct,
    timeHorizonMonths: profile.timeHorizonMonths,
    riskTolerance: profile.riskTolerance,
    goalProgressPct: Number(goalProgressPct.toFixed(1)),
    goalProgressNote,
  };
}

router.get("/goals", async (_req, res): Promise<void> => {
  const profile = await getProfile();
  res.json(GetInvestmentGoalsResponse.parse(await buildGoals(profile)));
});

router.put("/goals", async (req, res): Promise<void> => {
  const parsed = UpdateInvestmentGoalsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const profile = await getProfile();
  const [updated] = await db
    .update(profileTable)
    .set({
      totalCapital: parsed.data.totalCapital,
      targetReturnPct: parsed.data.targetReturnPct,
      timeHorizonMonths: parsed.data.timeHorizonMonths,
      riskTolerance: parsed.data.riskTolerance,
    })
    .where(eq(profileTable.id, profile.id))
    .returning();
  res.json(UpdateInvestmentGoalsResponse.parse(await buildGoals(updated!)));
});

export default router;
