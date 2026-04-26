import { Router, type IRouter } from "express";
import {
  GetRebalancingSuggestionsResponse,
  ApplyRebalancingResponse,
} from "@workspace/api-zod";
import { db, holdingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  getRebalancingActions,
  getAllocationRows,
} from "../lib/portfolio";

const router: IRouter = Router();

router.get("/rebalancing/suggestions", async (_req, res): Promise<void> => {
  const actions = await getRebalancingActions();
  res.json(GetRebalancingSuggestionsResponse.parse(actions));
});

router.post("/rebalancing/apply", async (_req, res): Promise<void> => {
  const rows = await getAllocationRows();
  const holdings = await db.select().from(holdingsTable);
  let appliedCount = 0;

  for (const row of rows) {
    if (Math.abs(row.differencePct) < 1) continue;
    const matching = holdings.filter((h) => h.assetClass === row.assetClass);
    if (matching.length === 0) continue;

    const adjust = row.targetPct / row.currentPct;
    if (!isFinite(adjust) || adjust <= 0) continue;

    for (const h of matching) {
      const newQty = h.quantity * adjust;
      await db
        .update(holdingsTable)
        .set({ quantity: Number(newQty.toFixed(6)) })
        .where(eq(holdingsTable.id, h.id));
    }
    appliedCount += 1;
  }

  res.json(ApplyRebalancingResponse.parse({ appliedCount }));
});

export default router;
