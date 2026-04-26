import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";
import {
  ListTransactionsQueryParams,
  ListTransactionsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/transactions", async (req, res): Promise<void> => {
  const params = ListTransactionsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const limit = params.data.limit ?? 50;
  const txs = await db
    .select()
    .from(transactionsTable)
    .orderBy(desc(transactionsTable.occurredAt))
    .limit(limit);
  res.json(
    ListTransactionsResponse.parse(
      txs.map((t) => ({
        id: String(t.id),
        occurredAt: t.occurredAt.toISOString(),
        type: t.type,
        asset: t.asset,
        amount: t.amount,
        value: t.value,
        status: t.status,
        note: t.note ?? undefined,
      })),
    ),
  );
});

export default router;
