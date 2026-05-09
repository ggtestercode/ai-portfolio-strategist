import { Router }                       from "express";
import { desc }                         from "drizzle-orm";
import {
  db,
  assistantMessagesTable,
  profileTable,
  holdingsTable,
  targetAllocationsTable,
  strategyOptionsTable,
} from "@workspace/db";
import {
  generateAssistantReply,
  getCachedContext,
  type AssistantContext,
} from "../lib/aiResponder";
import { approvalGate } from "../lib/approvalGate";

const router = Router();

// Build context from DB — cached 60s by getCachedContext
async function buildContext(): Promise<AssistantContext> {
  return getCachedContext(async () => {
    const [profile, holdings, allocations, strategy, config] = await Promise.all([
      db.select().from(profileTable).limit(1).then(r => r[0]),
      db.select().from(holdingsTable),
      db.select().from(targetAllocationsTable),
      db.select().from(strategyOptionsTable).limit(1).then(r => r[0]),
      approvalGate.getConfig(),
    ]);

    return {
      profile: {
        name:             profile?.name           ?? "Investor",
        riskTolerance:    (profile?.riskTolerance ?? "medium") as "low" | "medium" | "high",
        investmentGoal:   `Target return: ${profile?.targetReturnPct ?? 10}% over ${profile?.timeHorizonMonths ?? 12} months`,
        monthlyBudgetUsd: undefined,
      },
      totalPortfolioUsd:    holdings.reduce((s, h) => s + h.quantity * h.price, 0),
      availableCashUsd:     0,
      holdings:             holdings.map(h => ({
        symbol:           h.symbol,
        assetClass:       h.assetClass,
        currentValueUsd:  h.quantity * h.price,
        unrealisedPnlPct: h.change24hPct ?? 0,
      })),
      targetAllocations:    Object.fromEntries(
        allocations.map(a => [a.assetClass, a.targetPct])
      ),
      activeStrategy:       profile?.strategyType      ?? "Balanced Growth",
      rebalancingStatus:    "on_track"                 as const,
      operationMode:        config.mode,
      approvalThresholdUsd: config.thresholdUsd,
    };
  });
}

// POST /api/assistant/messages
router.post("/assistant/messages", async (req, res): Promise<void> => {
  try {
    const { message: rawMsg, content, history = [] } = req.body as {
      message?: string;
      content?: string;
      history?: Array<{ role: "user" | "assistant"; content: string }>;
    };
    const message = (content ?? rawMsg ?? "").trim();

    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const ctx   = await buildContext();
    const reply = await generateAssistantReply(message, ctx, history);

    await db.insert(assistantMessagesTable).values({ role: "user",      content: message       }).catch(() => {});
    await db.insert(assistantMessagesTable).values({ role: "assistant", content: reply.message }).catch(() => {});

    res.json({ message: reply.message, meta: reply._meta });
  } catch (err: any) {
    console.error("[assistant] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/command
router.post("/command", async (req, res): Promise<void> => {
  try {
    const { prompt, command } = req.body as { prompt?: string; command?: string };
    const text = (prompt ?? command ?? "").trim();
    if (!text) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    const ctx   = await buildContext();
    const reply = await generateAssistantReply(text, ctx);
    res.json({ reply: reply.message, meta: reply._meta });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assistant/messages
router.get("/assistant/messages", async (req, res): Promise<void> => {
  try {
    const limit    = Math.min(parseInt((req.query.limit as string) ?? "50", 10), 200);
    const messages = await db
      .select()
      .from(assistantMessagesTable)
      .orderBy(desc(assistantMessagesTable.id))
      .limit(limit);
    res.json(messages.reverse());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
