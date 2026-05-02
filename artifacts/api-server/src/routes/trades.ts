import { Router }                       from "express";
import { desc, gte }                    from "drizzle-orm";
import { db, llmUsageLogs, tradeProposals } from "@workspace/db";
import { approvalGate, buildProposal }  from "../lib/approvalGate";

const router = Router();

// POST /api/trades/propose
router.post("/trades/propose", async (req, res): Promise<void> => {
  const { symbol, side, amountUsd, assetClass, rationale, score, currentPrice, dataTimestamp } = req.body;

  if (!symbol || !side || !amountUsd || !assetClass || !rationale) {
    res.status(400).json({ error: "Missing required fields: symbol, side, amountUsd, assetClass, rationale" });
    return;
  }
  if (!["buy","sell"].includes(side)) {
    res.status(400).json({ error: "side must be 'buy' or 'sell'" });
    return;
  }
  if (typeof amountUsd !== "number" || amountUsd <= 0) {
    res.status(400).json({ error: "amountUsd must be a positive number" });
    return;
  }

  const proposal = buildProposal({
    symbol: String(symbol).toUpperCase(),
    side, amountUsd, assetClass, rationale,
    score, currentPrice, dataTimestamp,
  });

  const result = await approvalGate.submit(proposal);
  res.json(result);
});

// POST /api/trades/approve/:id
router.post("/trades/approve/:id", async (req, res): Promise<void> => {
  const result = await approvalGate.approve(req.params.id);
  res.json(result);
});

// POST /api/trades/reject/:id
router.post("/trades/reject/:id", async (req, res): Promise<void> => {
  const result = await approvalGate.reject(req.params.id);
  res.json(result);
});

// GET /api/trades/pending
router.get("/trades/pending", (_req, res): void => {
  res.json({ pending: approvalGate.getPending() });
});

// GET /api/trades/history
router.get("/trades/history", async (req, res): Promise<void> => {
  const limit  = Math.min(parseInt((req.query.limit as string) ?? "20", 10), 100);
  const trades = await db
    .select()
    .from(tradeProposals)
    .orderBy(desc(tradeProposals.proposedAt))
    .limit(limit);
  res.json({ trades });
});

// POST /api/trades/mode
router.post("/trades/mode", async (req, res): Promise<void> => {
  const { mode, threshold } = req.body as { mode: string; threshold?: number };
  if (!["autonomous","approval"].includes(mode)) {
    res.status(400).json({ error: "mode must be 'autonomous' or 'approval'" });
    return;
  }
  await approvalGate.setMode(mode as "autonomous" | "approval");
  if (typeof threshold === "number" && threshold > 0) {
    await approvalGate.setThreshold(threshold);
  }
  const config = await approvalGate.getConfig();
  res.json(config);
});

// GET /api/trades/config
router.get("/trades/config", async (_req, res): Promise<void> => {
  const config = await approvalGate.getConfig();
  res.json(config);
});

// GET /api/trades/llm-stats
router.get("/trades/llm-stats", async (_req, res): Promise<void> => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const logs  = await db
    .select()
    .from(llmUsageLogs)
    .where(gte(llmUsageLogs.calledAt, since))
    .orderBy(desc(llmUsageLogs.calledAt))
    .limit(200);

  const totalCost   = logs.reduce((s, l) => s + parseFloat(l.estimatedCostUsd), 0);
  const totalInput  = logs.reduce((s, l) => s + l.inputTokens,  0);
  const totalOutput = logs.reduce((s, l) => s + l.outputTokens, 0);
  const totalCached = logs.reduce((s, l) => s + l.cachedTokens, 0);
  const cacheHitPct = totalInput > 0 ? ((totalCached / totalInput) * 100).toFixed(1) : "0";

  const byTask = logs.reduce<Record<string, { calls: number; costUsd: number }>>((acc, l) => {
    if (!acc[l.taskType]) acc[l.taskType] = { calls: 0, costUsd: 0 };
    acc[l.taskType].calls++;
    acc[l.taskType].costUsd += parseFloat(l.estimatedCostUsd);
    return acc;
  }, {});

  res.json({
    period: "last 24h", totalCalls: logs.length,
    totalCostUsd: parseFloat(totalCost.toFixed(5)),
    totalInputTokens: totalInput, totalOutputTokens: totalOutput,
    totalCachedTokens: totalCached, cacheHitPct: `${cacheHitPct}%`,
    byTask,
  });
});

export { router as tradesRouter };
