import { Router } from "express";
import { processWebhookUpdate } from "../notifications/telegram";

const router = Router();

router.post("/api/telegram/webhook", (req, res) => {
  try {
    processWebhookUpdate(req.body);
  } catch (err) {
    console.error("[telegram webhook]", err);
  }
  res.sendStatus(200);
});

export default router;
