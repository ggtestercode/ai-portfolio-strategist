import { Router, type IRouter } from "express";
import {
  GetPerformanceSeriesQueryParams,
  GetPerformanceSeriesResponse,
} from "@workspace/api-zod";
import { getProfile } from "../lib/profile";
import { getPortfolioSnapshot } from "../lib/portfolio";
import { buildPerformanceSeries } from "../lib/performance";
import { db } from "@workspace/db";
import { tradeMemoryTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { backfillStructuredReflections } from "../lib/tradeMemoryLib";

const router: IRouter = Router();

const RANGE_START_FACTOR: Record<string, number> = {
  "1D": 0.985,
  "7D": 0.97,
  "1M": 0.92,
  "3M": 0.88,
  "1Y": 0.78,
  ALL: 0.6,
};

router.get("/performance/series", async (req, res): Promise<void> => {
  const params = GetPerformanceSeriesQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const range = (params.data.range ?? "1M") as
    | "1D"
    | "7D"
    | "1M"
    | "3M"
    | "1Y"
    | "ALL";
  const profile = await getProfile();
  const snap = await getPortfolioSnapshot(profile.totalCapital);
  const endValue   = snap.totalValue > 0 ? snap.totalValue : profile.totalCapital || 1000;
  const startValue = endValue * (RANGE_START_FACTOR[range] ?? 0.9);
  const series = buildPerformanceSeries(range, startValue, endValue);
  res.json(GetPerformanceSeriesResponse.parse(series));
});

// Admin-only: delete a trade_memory TRADE_CLOSE record by source_trade_id, then
// trigger backfill to regenerate the reflection under the current prompt.
// Usage: POST /admin/re-reflect  body: { tradeLogIds: ["uuid1", "uuid2"] }
router.post("/admin/re-reflect", async (req, res): Promise<void> => {
  const { tradeLogIds } = req.body as { tradeLogIds?: string[] };
  if (!Array.isArray(tradeLogIds) || tradeLogIds.length === 0) {
    res.status(400).json({ error: "tradeLogIds array required" });
    return;
  }
  const deleted: string[] = [];
  for (const id of tradeLogIds) {
    const rows = await db.delete(tradeMemoryTable)
      .where(and(eq(tradeMemoryTable.sourceTradeId, id), eq(tradeMemoryTable.action, "TRADE_CLOSE")))
      .returning({ id: tradeMemoryTable.id });
    if (rows.length > 0) deleted.push(id);
  }
  // Backfill picks up trades whose TRADE_CLOSE record was just deleted.
  backfillStructuredReflections(tradeLogIds.length + 1).catch(e =>
    console.error("[admin/re-reflect] backfill error:", e)
  );
  res.json({ deleted, backfillTriggered: true, note: "check PM2 logs for [C1]/[C2]/[C7b] fires and [tradeMemory] stored lines" });
});

export default router;
