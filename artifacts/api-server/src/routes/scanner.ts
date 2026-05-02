import { Router }                         from "express";
import { cache, CacheKey }               from "../lib/contextCache";
import { runScan }                        from "../lib/marketScanner";
import { rebalanceNow }                  from "../lib/rebalancer";
import { getWatchlist, addToWatchlist, removeFromWatchlist } from "../lib/watchlist";
import { approvalGate }                  from "../lib/approvalGate";

const router = Router();

// GET /api/mode — current operation mode + threshold
router.get("/mode", async (_req, res): Promise<void> => {
  try {
    const config = await approvalGate.getConfig();
    res.json({ mode: config.mode, thresholdUsd: config.thresholdUsd });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /api/mode — set mode: { mode: "autonomous" | "approval" }
router.post("/mode", async (req, res): Promise<void> => {
  const { mode } = req.body as { mode?: "autonomous" | "approval" };
  if (mode !== "autonomous" && mode !== "approval") {
    res.status(400).json({ error: "mode must be 'autonomous' or 'approval'" });
    return;
  }
  try {
    await approvalGate.setMode(mode);
    res.json({ ok: true, mode });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// GET /api/scan/signals — alias for latest cached scan results
router.get("/scan/signals", async (_req, res): Promise<void> => {
  try {
    const result = await runScan();
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /api/scan/signals — force a fresh scan and return signals
router.post("/scan/signals", async (_req, res): Promise<void> => {
  try {
    cache.invalidate(CacheKey.marketScan());
    const result = await runScan();
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /api/scan/run — trigger immediate scan
router.post("/scan/run", async (_req, res): Promise<void> => {
  try {
    cache.invalidate(CacheKey.marketScan());
    const result = await runScan();
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// GET /api/scan/latest — return cached result (or run if not cached)
router.get("/scan/latest", async (_req, res): Promise<void> => {
  try {
    const result = await runScan();
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /api/rebalance — trigger immediate rebalance
router.post("/rebalance", async (_req, res): Promise<void> => {
  try {
    const result = await rebalanceNow();
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// GET /api/watchlist
router.get("/watchlist", async (_req, res): Promise<void> => {
  try {
    res.json({ watchlist: await getWatchlist() });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /api/watchlist/add — body: { symbol, assetClass }
router.post("/watchlist/add", async (req, res): Promise<void> => {
  const { symbol, assetClass } = req.body as { symbol?: string; assetClass?: string };
  if (!symbol?.trim()) { res.status(400).json({ error: "symbol required" }); return; }
  await addToWatchlist(symbol.trim(), assetClass?.trim() ?? "Equity");
  res.json({ ok: true, symbol: symbol.toUpperCase() });
});

// DELETE /api/watchlist/:symbol
router.delete("/watchlist/:symbol", async (req, res): Promise<void> => {
  const removed = await removeFromWatchlist(req.params.symbol ?? "");
  res.json({ ok: removed, symbol: req.params.symbol?.toUpperCase() });
});

export default router;
