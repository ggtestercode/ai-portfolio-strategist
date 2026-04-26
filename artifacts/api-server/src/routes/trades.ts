import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, tradeSuggestionsTable } from "@workspace/db";
import {
  GetTradeSuggestionsResponse,
  GetLastTradeSuggestionResponse,
  ApplyTradeSuggestionParams,
  ApplyTradeSuggestionResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serialize(t: typeof tradeSuggestionsTable.$inferSelect) {
  return {
    id: String(t.id),
    symbol: t.symbol,
    pair: t.pair,
    side: t.side,
    status: t.status,
    entryRangeLow: t.entryRangeLow,
    entryRangeHigh: t.entryRangeHigh,
    target: t.target,
    stopLoss: t.stopLoss,
    positionSize: t.positionSize ?? undefined,
    suggestedAction: t.suggestedAction ?? undefined,
    reasoning: t.reasoning ?? undefined,
    riskWarning: t.riskWarning,
    createdAt: t.createdAt.toISOString(),
    summary: t.summary,
  };
}

router.get("/trades/suggestions", async (_req, res): Promise<void> => {
  const trades = await db
    .select()
    .from(tradeSuggestionsTable)
    .orderBy(desc(tradeSuggestionsTable.createdAt));
  res.json(GetTradeSuggestionsResponse.parse(trades.map(serialize)));
});

router.get("/trades/last", async (_req, res): Promise<void> => {
  const [latest] = await db
    .select()
    .from(tradeSuggestionsTable)
    .orderBy(desc(tradeSuggestionsTable.createdAt))
    .limit(1);
  if (!latest) {
    res.status(404).json({ error: "No trade suggestions yet" });
    return;
  }
  res.json(GetLastTradeSuggestionResponse.parse(serialize(latest)));
});

router.post("/trades/:id/apply", async (req, res): Promise<void> => {
  const parsed = ApplyTradeSuggestionParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const id = Number(parsed.data.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [updated] = await db
    .update(tradeSuggestionsTable)
    .set({ status: "Applied" })
    .where(eq(tradeSuggestionsTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Trade suggestion not found" });
    return;
  }
  res.json(ApplyTradeSuggestionResponse.parse(serialize(updated)));
});

export default router;
