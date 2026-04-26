import { Router, type IRouter } from "express";
import {
  GetPerformanceSeriesQueryParams,
  GetPerformanceSeriesResponse,
} from "@workspace/api-zod";
import { getProfile } from "../lib/profile";
import { getPortfolioSnapshot } from "../lib/portfolio";
import { buildPerformanceSeries } from "../lib/performance";

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
  const startValue = snap.totalValue * (RANGE_START_FACTOR[range] ?? 0.9);
  const series = buildPerformanceSeries(range, startValue, snap.totalValue);
  res.json(GetPerformanceSeriesResponse.parse(series));
});

export default router;
