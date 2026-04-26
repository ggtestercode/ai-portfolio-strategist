import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, riskAlertsTable } from "@workspace/db";
import {
  ListAlertsResponse,
  DismissAlertParams,
  DismissAlertResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serialize(a: typeof riskAlertsTable.$inferSelect) {
  return {
    id: String(a.id),
    severity: a.severity,
    title: a.title,
    message: a.message,
    createdAt: a.createdAt.toISOString(),
    dismissed: a.dismissed,
  };
}

router.get("/alerts", async (_req, res): Promise<void> => {
  const alerts = await db
    .select()
    .from(riskAlertsTable)
    .orderBy(desc(riskAlertsTable.createdAt));
  res.json(ListAlertsResponse.parse(alerts.map(serialize)));
});

router.post("/alerts/:id/dismiss", async (req, res): Promise<void> => {
  const params = DismissAlertParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const id = Number(params.data.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [updated] = await db
    .update(riskAlertsTable)
    .set({ dismissed: true })
    .where(eq(riskAlertsTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  res.json(DismissAlertResponse.parse(serialize(updated)));
});

export default router;
