import { Router, type IRouter } from "express";
import {
  GetPortfolioResponse,
  GetPortfolioAllocationResponse,
  GetHoldingsResponse,
} from "@workspace/api-zod";
import { getProfile } from "../lib/profile";
import {
  getPortfolioSnapshot,
  getAllocationRows,
  loadHoldings,
} from "../lib/portfolio";
import { syncAllHoldingsToDB } from "../lib/aiResponder";

const router: IRouter = Router();

router.get("/portfolio", async (_req, res): Promise<void> => {
  const profile = await getProfile();
  const snap = await getPortfolioSnapshot(profile.totalCapital);
  res.json(
    GetPortfolioResponse.parse({
      totalValue: Number(snap.totalValue.toFixed(2)),
      totalProfitLoss: Number(snap.totalProfitLoss.toFixed(2)),
      totalProfitLossPct: Number(snap.totalProfitLossPct.toFixed(2)),
      change24h: Number(snap.change24h.toFixed(2)),
      change24hPct: Number(snap.change24hPct.toFixed(2)),
    }),
  );
});

router.get("/portfolio/allocation", async (_req, res): Promise<void> => {
  res.json(GetPortfolioAllocationResponse.parse(await getAllocationRows()));
});

router.get("/portfolio/holdings", async (_req, res): Promise<void> => {
  const holdings = await loadHoldings();
  const out = holdings.map((h) => ({
    id: String(h.id),
    symbol: h.symbol,
    name: h.name,
    assetClass: h.assetClass,
    quantity: h.quantity,
    price: h.price,
    value: Number((h.quantity * h.price).toFixed(2)),
    change24hPct: h.change24hPct,
  }));
  res.json(GetHoldingsResponse.parse(out));
});

router.post("/portfolio/sync", async (_req, res): Promise<void> => {
  try {
    await syncAllHoldingsToDB();
    const holdings = await loadHoldings();
    res.json({ synced: holdings.length, holdings: holdings.map(h => h.symbol) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
