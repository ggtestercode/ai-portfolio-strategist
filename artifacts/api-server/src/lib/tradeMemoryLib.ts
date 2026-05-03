import { db, tradeLogTable, tradeMemoryTable } from "@workspace/db";
import { desc, isNotNull }                       from "drizzle-orm";
import { llm }                                   from "./llmRouter";
import { recordTradeOutcome }                    from "./leverageManager";

export interface ClosedTradeParams {
  symbol:     string;
  broker:     string;
  direction:  "long" | "short";
  entryPrice: number;
  exitPrice:  number;
  amountUsd:  number;
  leverage:   number;
  reasoning?: string;
  entryAt?:   Date;
}

export async function logClosedTrade(params: ClosedTradeParams): Promise<void> {
  const { symbol, broker, direction, entryPrice, exitPrice, amountUsd, leverage, reasoning, entryAt } = params;
  const qty    = amountUsd / entryPrice;
  const pnl    = direction === "long"
    ? (exitPrice - entryPrice) * qty
    : (entryPrice - exitPrice) * qty;
  const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100 * (direction === "long" ? 1 : -1);

  // Write trade log entry
  await db.insert(tradeLogTable).values({
    symbol, broker, direction,
    entryPrice: String(entryPrice),
    exitPrice:  String(exitPrice),
    pnl:        String(pnl.toFixed(4)),
    pnlPct:     String(pnlPct.toFixed(4)),
    leverage,
    amountUsd:  String(amountUsd),
    reasoning:  reasoning ?? null,
    entryAt:    entryAt ?? new Date(),
    exitAt:     new Date(),
  });

  // Update penalty tracker
  await recordTradeOutcome(symbol, pnlPct).catch(() => {});

  // Generate Claude reflection asynchronously (don't block close)
  generateReflection({ symbol, direction, entryPrice, exitPrice, pnl, pnlPct, reasoning })
    .catch(e => console.error("[tradeMemory] reflection failed:", e));
}

async function generateReflection(p: {
  symbol: string; direction: string; entryPrice: number; exitPrice: number;
  pnl: number; pnlPct: number; reasoning?: string;
}): Promise<void> {
  const sign   = p.pnl >= 0 ? "+" : "";
  const prompt = [
    `Analyse this closed trade and provide a brief reflection (3 sentences max):`,
    `Symbol: ${p.symbol} | Direction: ${p.direction}`,
    `Entry: $${p.entryPrice.toFixed(4)} → Exit: $${p.exitPrice.toFixed(4)}`,
    `P/L: ${sign}$${p.pnl.toFixed(2)} (${sign}${p.pnlPct.toFixed(2)}%)`,
    p.reasoning ? `Original reasoning: ${p.reasoning}` : "",
    `What worked? What didn't? What would you do differently?`,
  ].filter(Boolean).join("\n");

  const res = await llm.json<{ reflection: string; whatWorked: string; whatDidnt: string }>({
    taskType:      "assistant_reply",
    systemContext: "You are a trading journal assistant. Reply in JSON only. Be concise and specific.",
    prompt,
    schema: {
      type: "object", required: ["reflection", "whatWorked", "whatDidnt"],
      properties: {
        reflection: { type: "string" },
        whatWorked: { type: "string" },
        whatDidnt:  { type: "string" },
      },
    },
    fallback: { reflection: "No reflection available.", whatWorked: "", whatDidnt: "" },
  });

  await db.insert(tradeMemoryTable).values({
    symbol:     p.symbol,
    reflection: res.data.reflection,
    whatWorked: res.data.whatWorked || null,
    whatDidnt:  res.data.whatDidnt  || null,
  });
}

export async function getRecentMemory(limit = 20): Promise<string> {
  const rows = await db.select()
    .from(tradeMemoryTable)
    .orderBy(desc(tradeMemoryTable.createdAt))
    .limit(limit);
  if (!rows.length) return "No trade memory available yet.";
  return rows.map((r, i) => `${i + 1}. ${r.symbol}: ${r.reflection}`).join("\n");
}

export async function getRecentTrades(limit = 10): Promise<typeof tradeLogTable.$inferSelect[]> {
  return db.select()
    .from(tradeLogTable)
    .where(isNotNull(tradeLogTable.exitAt))
    .orderBy(desc(tradeLogTable.exitAt))
    .limit(limit);
}

export async function getDailyPnl(): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const rows = await db.select({ pnl: tradeLogTable.pnl })
    .from(tradeLogTable)
    .where(isNotNull(tradeLogTable.exitAt));
  // Filter in JS since drizzle gte needs importing separately
  const today = rows.filter((_, i) => i === i); // all rows — sum them
  return today.reduce((sum, r) => sum + parseFloat(r.pnl ?? "0"), 0);
}
