import { Router, type IRouter } from "express";
import { asc } from "drizzle-orm";
import { db, assistantMessagesTable } from "@workspace/db";
import {
  ListAssistantMessagesResponse,
  SendAssistantMessageBody,
  SendAssistantMessageResponse,
  RunCommandBody,
  RunCommandResponse,
} from "@workspace/api-zod";
import { generateAssistantReply } from "../lib/aiResponder";

const router: IRouter = Router();

function serialize(m: typeof assistantMessagesTable.$inferSelect) {
  return {
    id: String(m.id),
    role: m.role,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
  };
}

router.get("/assistant/messages", async (_req, res): Promise<void> => {
  const msgs = await db
    .select()
    .from(assistantMessagesTable)
    .orderBy(asc(assistantMessagesTable.createdAt));
  res.json(ListAssistantMessagesResponse.parse(msgs.map(serialize)));
});

router.post("/assistant/messages", async (req, res): Promise<void> => {
  const parsed = SendAssistantMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const content = parsed.data.content.trim();
  if (!content) {
    res.status(400).json({ error: "content cannot be empty" });
    return;
  }

  const [userMessage] = await db
    .insert(assistantMessagesTable)
    .values({ role: "user", content })
    .returning();

  const reply = await generateAssistantReply(content);
  const [assistantMessage] = await db
    .insert(assistantMessagesTable)
    .values({ role: "assistant", content: reply })
    .returning();

  res.json(
    SendAssistantMessageResponse.parse({
      userMessage: serialize(userMessage!),
      assistantMessage: serialize(assistantMessage!),
    }),
  );
});

router.post("/command", async (req, res): Promise<void> => {
  const parsed = RunCommandBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const reply = await generateAssistantReply(parsed.data.prompt);
  res.json(RunCommandResponse.parse({ reply }));
});

export default router;
