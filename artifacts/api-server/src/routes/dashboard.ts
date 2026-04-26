import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, riskAlertsTable, targetAllocationsTable } from "@workspace/db";
import { GetDashboardSummaryResponse } from "@workspace/api-zod";
import { getProfile } from "../lib/profile";
import {
  getPortfolioSnapshot,
  getAllocationRows,
} from "../lib/portfolio";

const router: IRouter = Router();

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  const profile = await getProfile();
  const snap = await getPortfolioSnapshot(profile.totalCapital);
  const allocation = await getAllocationRows();
  const targets = await db.select().from(targetAllocationsTable);

  const targetValue = profile.totalCapital * (1 + profile.targetReturnPct / 100);
  const goalProgressPct =
    targetValue > profile.totalCapital
      ? Math.max(
          0,
          Math.min(
            100,
            ((snap.totalValue - profile.totalCapital) /
              (targetValue - profile.totalCapital)) *
              100,
          ),
        )
      : 0;
  const goalProgressNote =
    goalProgressPct >= 60
      ? "You are on track to achieve your target return."
      : goalProgressPct >= 30
        ? "Solid progress — keep monitoring volatility."
        : "Consider reviewing your strategy to accelerate progress.";

  const activeAlerts = await db
    .select()
    .from(riskAlertsTable)
    .where(eq(riskAlertsTable.dismissed, false));

  const maxDrift = allocation.reduce(
    (m, r) => Math.max(m, Math.abs(r.differencePct)),
    0,
  );
  const driftScore = Math.max(0, 25 - maxDrift * 2);
  const alertScore = Math.max(0, 25 - activeAlerts.length * 5);
  const profitScore = Math.max(0, Math.min(25, snap.totalProfitLossPct * 1.5));
  const goalScore = (goalProgressPct / 100) * 25;
  const healthScore = Math.round(driftScore + alertScore + profitScore + goalScore);
  const healthLabel =
    healthScore >= 80
      ? "Excellent"
      : healthScore >= 65
        ? "Good"
        : healthScore >= 45
          ? "Fair"
          : "Needs Attention";
  const healthNote =
    healthScore >= 65
      ? "Well diversified. Keep monitoring!"
      : "Consider reviewing your rebalancing suggestions.";

  res.json(
    GetDashboardSummaryResponse.parse({
      portfolio: {
        totalValue: Number(snap.totalValue.toFixed(2)),
        totalProfitLoss: Number(snap.totalProfitLoss.toFixed(2)),
        totalProfitLossPct: Number(snap.totalProfitLossPct.toFixed(2)),
        change24h: Number(snap.change24h.toFixed(2)),
        change24hPct: Number(snap.change24hPct.toFixed(2)),
      },
      goals: {
        totalCapital: profile.totalCapital,
        targetReturnPct: profile.targetReturnPct,
        timeHorizonMonths: profile.timeHorizonMonths,
        riskTolerance: profile.riskTolerance,
        goalProgressPct: Number(goalProgressPct.toFixed(1)),
        goalProgressNote,
      },
      strategy: {
        strategyType: profile.strategyType,
        lastGenerated: profile.strategyLastGenerated.toISOString(),
        riskLevel: profile.strategyRiskLevel,
        allocation: targets
          .map((t) => ({ assetClass: t.assetClass, percentage: t.targetPct }))
          .sort((a, b) => b.percentage - a.percentage),
        keyRules: profile.strategyKeyRules,
      },
      alertsCount: activeAlerts.length,
      healthScore,
      healthLabel,
      healthNote,
    }),
  );
});

// Keep `and` import used to avoid unused-import errors.
void and;
void eq;

export default router;
