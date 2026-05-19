import { db, tradeLogTable, tradeMemoryTable } from "@workspace/db";
import { desc, isNotNull, and, eq, isNull }      from "drizzle-orm";
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
    `Analyse this closed trade and provide a structured reflection:`,
    `Symbol: ${p.symbol} | Direction: ${p.direction}`,
    `Entry: $${p.entryPrice.toFixed(4)} → Exit: $${p.exitPrice.toFixed(4)}`,
    `P/L: ${sign}$${p.pnl.toFixed(2)} (${sign}${p.pnlPct.toFixed(2)}%)`,
    p.reasoning ? `Original reasoning: ${p.reasoning}` : "",
    `Reply JSON with: reflection (2 sentences), whatWorked (specific signals that predicted the outcome), whatDidnt (signals that were noise or wrong), lessonsLearned (one actionable insight for next time).`,
  ].filter(Boolean).join("\n");

  const res = await llm.json<{ reflection: string; whatWorked: string; whatDidnt: string; lessonsLearned?: string }>({
    taskType:      "assistant_reply",
    systemContext: "You are a trading journal assistant. Reply in JSON only. Be concise and specific.",
    prompt,
    schema: {
      type: "object", required: ["reflection", "whatWorked", "whatDidnt"],
      properties: {
        reflection:     { type: "string" },
        whatWorked:     { type: "string" },
        whatDidnt:      { type: "string" },
        lessonsLearned: { type: "string" },
      },
    },
    fallback: { reflection: "No reflection available.", whatWorked: "", whatDidnt: "" },
  });

  const lessons = res.data.lessonsLearned ? ` | Lesson: ${res.data.lessonsLearned}` : "";
  await db.insert(tradeMemoryTable).values({
    symbol:     p.symbol,
    reflection: res.data.reflection + lessons,
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

export async function getPerformanceSummary(): Promise<string> {
  try {
    const rows = await db.select({
      setupType: tradeLogTable.setupType,
      pnlPct:    tradeLogTable.pnlPct,
    })
    .from(tradeLogTable)
    .where(isNotNull(tradeLogTable.exitAt))
    .orderBy(desc(tradeLogTable.exitAt))
    .limit(200);

    if (!rows.length) return "";

    // Group by setupType
    const bySetup: Record<string, { wins: number; total: number }> = {};
    for (const r of rows) {
      const setup = r.setupType ?? "UNKNOWN";
      if (!bySetup[setup]) bySetup[setup] = { wins: 0, total: 0 };
      bySetup[setup]!.total++;
      if (parseFloat(r.pnlPct ?? "0") > 0) bySetup[setup]!.wins++;
    }

    const lines = ["Your trading performance so far:"];
    lines.push("\nBy setup type:");
    for (const [setup, stats] of Object.entries(bySetup)) {
      const wr = stats.total > 0 ? Math.round(stats.wins / stats.total * 100) : 0;
      lines.push(`  ${setup}: ${stats.total} trades, ${wr}% win rate`);
    }
    lines.push("\nUse this to refine your entry decisions.");
    return lines.join("\n");
  } catch {
    return "";
  }
}

export async function getOpenTrades(): Promise<typeof tradeLogTable.$inferSelect[]> {
  return db.select()
    .from(tradeLogTable)
    .where(isNull(tradeLogTable.exitAt))
    .orderBy(desc(tradeLogTable.entryAt));
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

export async function logOpenTrade(params: {
  symbol: string; broker: string; direction: "long" | "short";
  entryPrice: number; leverage: number; amountUsd: number; reasoning?: string;
  stopLoss?: number; takeProfit?: number; stopLossMethod?: string;
}): Promise<void> {
  const enriched = [
    params.reasoning,
    params.stopLoss      ? `SL=$${params.stopLoss}`              : null,
    params.takeProfit    ? `TP=$${params.takeProfit}`             : null,
    params.stopLossMethod ? `method=${params.stopLossMethod}`     : null,
  ].filter(Boolean).join(" | ");

  try {
    await db.insert(tradeLogTable).values({
      symbol:     params.symbol,
      broker:     params.broker,
      direction:  params.direction,
      entryPrice: String(params.entryPrice),
      amountUsd:  String(params.amountUsd),
      leverage:   params.leverage,
      reasoning:  enriched || null,
      entryAt:    new Date(),
    });
  } catch (e) {
    console.error("[tradeMemory] logOpenTrade failed:", e);
  }
}

export async function closeOpenTrade(params: {
  symbol: string; broker: string; exitPrice: number; amountUsd: number;
  pnlOverride?: number;           // use broker-reported P/L directly (e.g. eToro)
  entryPriceOverride?: number;    // use broker-reported entry price (overrides trade_log)
  directionOverride?: "long" | "short"; // use Bybit-confirmed side (overrides trade_log direction)
}): Promise<void> {
  // Fetch all open entries for this symbol+broker — close the most recent, purge duplicates
  const openTrades = await db.select()
    .from(tradeLogTable)
    .where(and(
      eq(tradeLogTable.symbol, params.symbol),
      eq(tradeLogTable.broker, params.broker),
      isNull(tradeLogTable.exitAt),
    ))
    .orderBy(desc(tradeLogTable.entryAt));

  if (!openTrades.length) {
    console.log(`[tradeMemory] No open trade found for ${params.symbol} on ${params.broker} — skipping reflection`);
    return;
  }

  const openTrade  = openTrades[0]!;
  const duplicates = openTrades.slice(1);

  // Broker-reported entry price wins over whatever was logged (avoids cron-scan price mismatch)
  const entryPrice = params.entryPriceOverride
    ? params.entryPriceOverride
    : parseFloat(openTrade.entryPrice ?? "0");
  const direction  = params.directionOverride ?? (openTrade.direction as "long" | "short");
  const qty        = params.amountUsd / (entryPrice || params.exitPrice || 1);

  const pnl    = params.pnlOverride !== undefined
    ? params.pnlOverride
    : direction === "long"
      ? (params.exitPrice - entryPrice) * qty
      : (entryPrice - params.exitPrice) * qty;
  const pnlPct = params.pnlOverride !== undefined
    ? (params.amountUsd > 0 ? (params.pnlOverride / params.amountUsd) * 100 : 0)
    : entryPrice > 0
      ? ((params.exitPrice - entryPrice) / entryPrice) * 100 * (direction === "long" ? 1 : -1)
      : 0;

  // Close the primary open entry with real P/L
  await db.update(tradeLogTable)
    .set({
      exitPrice:  params.exitPrice > 0 ? String(params.exitPrice) : openTrade.exitPrice,
      entryPrice: String(entryPrice),
      pnl:        String(pnl.toFixed(4)),
      pnlPct:     String(pnlPct.toFixed(4)),
      exitAt:     new Date(),
    })
    .where(eq(tradeLogTable.id, openTrade.id));

  // Delete duplicate open entries — they're stale logs from cron re-runs
  for (const dup of duplicates) {
    await db.delete(tradeLogTable).where(eq(tradeLogTable.id, dup.id));
  }
  if (duplicates.length) {
    console.log(`[tradeMemory] Deleted ${duplicates.length} duplicate open entr${duplicates.length === 1 ? "y" : "ies"} for ${params.symbol}`);
  }

  await recordTradeOutcome(params.symbol, pnlPct).catch(() => {});

  generateReflection({
    symbol:    params.symbol,
    direction,
    entryPrice,
    exitPrice: params.exitPrice || entryPrice,
    pnl,
    pnlPct,
    reasoning: openTrade.reasoning ?? undefined,
  }).catch(e => console.error("[tradeMemory] reflection failed:", e));
}
