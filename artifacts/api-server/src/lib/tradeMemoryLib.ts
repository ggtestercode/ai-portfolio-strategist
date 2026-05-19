import {
  db, tradeLogTable, tradeMemoryTable, paperTradesTable, botStateTable,
} from "@workspace/db";
import { desc, isNotNull, and, eq, isNull, asc, gte, lte } from "drizzle-orm";
import { llm }                                from "./llmRouter";
import { recordTradeOutcome }                 from "./leverageManager";
import { getClosedPnl as bybitGetClosedPnl }  from "../brokers/bybit";

// ─── Types ────────────────────────────────────────────────────────────────────

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

interface ReflectionInput {
  symbol:      string;
  direction:   string;
  entryPrice:  number;
  exitPrice:   number;
  pnl:         number;
  pnlPct:      number;
  reasoning?:  string;
  entryAt?:    Date | null;
  exitAt?:     Date | null;
  setupType?:  string | null;
  score?:      string | null;
  whyNow?:     string | null;
  sl?:         string | null;
  tp1?:        string | null;
  tp2?:        string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const toSGT = (d: Date) => {
  const sgt = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return sgt.toISOString().replace("T", " ").slice(0, 16) + " SGT";
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── logClosedTrade (eToro / legacy) ─────────────────────────────────────────

export async function logClosedTrade(params: ClosedTradeParams): Promise<void> {
  const { symbol, broker, direction, entryPrice, exitPrice, amountUsd, leverage, reasoning, entryAt } = params;
  const qty    = amountUsd / entryPrice;
  const pnl    = direction === "long"
    ? (exitPrice - entryPrice) * qty
    : (entryPrice - exitPrice) * qty;
  const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100 * (direction === "long" ? 1 : -1);

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

  await recordTradeOutcome(symbol, pnlPct).catch(() => {});

  generateReflection({ symbol, direction, entryPrice, exitPrice, pnl, pnlPct, reasoning,
    entryAt: entryAt ?? new Date(), exitAt: new Date() })
    .catch(e => console.error("[tradeMemory] reflection failed:", e));
}

// ─── Core reflection engine ───────────────────────────────────────────────────

async function generateReflection(input: ReflectionInput): Promise<void> {
  const sign = input.pnl >= 0 ? "+" : "";

  // 1. Fetch Bybit closed-pnl for this symbol within the trade window
  type BybitClose = { closedSize: number; avgExitPrice: number; avgEntryPrice: number; closedPnl: number; closedAt: number; openedAt: number; side: string };
  let bybitCloses: BybitClose[] = [];
  if (input.entryAt) {
    try {
      const startMs = Math.max(0, input.entryAt.getTime() - 4 * 60 * 60 * 1000);
      const raw = await bybitGetClosedPnl(50, startMs, input.symbol);
      bybitCloses = raw
        .filter(c => Math.abs(c.avgEntryPrice / input.entryPrice - 1) < 0.06)
        .sort((a, b) => a.closedAt - b.closedAt);
    } catch { /* non-fatal — Bybit data enriches but isn't required */ }
  }

  const bybitTotalPnl   = bybitCloses.reduce((s, c) => s + c.closedPnl, 0);
  const bybitTotalQty   = bybitCloses.reduce((s, c) => s + c.closedSize, 0);
  const partials        = bybitCloses.length > 1 ? bybitCloses.slice(0, -1) : [];
  const estimatedFees   = Math.abs(input.pnl) * 0.002; // ~0.1% in + 0.1% out taker approx

  // 2. Version B comparison (paper_trades)
  let versionBStr = "Version B had no trade on this symbol in the same period.";
  try {
    if (input.entryAt) {
      const windowStart = new Date(input.entryAt.getTime() - 48 * 60 * 60 * 1000);
      const windowEnd   = input.exitAt ? new Date(input.exitAt.getTime() + 48 * 60 * 60 * 1000) : new Date();
      const [vb] = await db.select().from(paperTradesTable)
        .where(and(
          eq(paperTradesTable.symbol, input.symbol),
          eq(paperTradesTable.version, "B"),
          gte(paperTradesTable.signalTime, windowStart),
          lte(paperTradesTable.signalTime, windowEnd),
        ))
        .orderBy(desc(paperTradesTable.signalTime))
        .limit(1);
      if (vb) {
        const vbRes = vb.wouldHavePnlPct != null
          ? `${vb.wouldHavePnlPct >= 0 ? "+" : ""}${vb.wouldHavePnlPct.toFixed(2)}%`
          : vb.status === "open" ? "still open" : "not resolved";
        versionBStr = [
          `Version B direction: ${vb.direction}`,
          `Version B entry: $${vb.entryPrice.toFixed(4)}`,
          `Version B score: ${vb.score ?? "?"} | setup: ${vb.setupType ?? "?"} | regime: ${vb.regime ?? "?"}`,
          `Version B result: ${vbRes}`,
          vb.whyNow ? `Version B whyNow: ${vb.whyNow}` : "",
        ].filter(Boolean).join("\n");
      }
    }
  } catch { /* non-fatal */ }

  // 3. Current regime from bot_state
  let regime = "UNKNOWN";
  try {
    const [state] = await db.select({ currentRegime: botStateTable.currentRegime })
      .from(botStateTable).limit(1);
    regime = state?.currentRegime ?? "UNKNOWN";
  } catch { /* non-fatal */ }

  // 4. Hold duration
  const holdMs      = input.entryAt && input.exitAt
    ? input.exitAt.getTime() - input.entryAt.getTime() : null;
  const holdHours   = holdMs !== null ? Math.floor(holdMs / 3600000) : null;
  const holdMinutes = holdMs !== null ? Math.floor((holdMs % 3600000) / 60000) : null;

  // 5. Partial close description
  const partialsSection = partials.length > 0
    ? partials.map((p, i) => {
        const pct = bybitTotalQty > 0 ? Math.round(p.closedSize / bybitTotalQty * 100) : 0;
        return [
          `→ Partial ${i + 1} at ${toSGT(new Date(p.closedAt))}:`,
          `  Closed ${p.closedSize} (≈${pct}% of position)`,
          `  Price: $${p.avgExitPrice.toFixed(4)} | P/L: ${p.closedPnl >= 0 ? "+" : ""}$${p.closedPnl.toFixed(2)}`,
        ].join("\n");
      }).join("\n")
    : "No partial closes recorded for this position.";

  // 6. Prompt
  const prompt = [
    `Complete trade record for structured reflection:`,
    ``,
    `Symbol: ${input.symbol}`,
    `Direction: ${input.direction} (confirmed from Bybit side field)`,
    `Entry: $${input.entryPrice.toFixed(4)}${input.entryAt ? ` at ${toSGT(input.entryAt)}` : ""}`,
    `Final exit: $${input.exitPrice.toFixed(4)}${input.exitAt ? ` at ${toSGT(input.exitAt)}` : ""}`,
    holdHours !== null ? `Hold duration: ${holdHours}h ${holdMinutes}m` : "",
    bybitTotalPnl !== 0
      ? `Gross P/L (Bybit verified): ${bybitTotalPnl >= 0 ? "+" : ""}$${bybitTotalPnl.toFixed(2)} | Est. fees: ~$${estimatedFees.toFixed(2)}`
      : `Gross P/L: ${sign}$${input.pnl.toFixed(2)} | Est. fees: ~$${estimatedFees.toFixed(2)}`,
    `Net P/L: ${sign}${input.pnlPct.toFixed(2)}%`,
    ``,
    `Market context at entry:`,
    `- Regime (current): ${regime}`,
    `- Score at entry: ${input.score ?? "unknown"}/100`,
    `- Setup type: ${input.setupType ?? "unknown"}`,
    `- Why now: ${input.whyNow ?? input.reasoning ?? "unknown"}`,
    `- SL: ${input.sl ? "$" + parseFloat(input.sl).toFixed(4) : "not set"} | TP1: ${input.tp1 ? "$" + parseFloat(input.tp1).toFixed(4) : "not set"} | TP2: ${input.tp2 ? "$" + parseFloat(input.tp2).toFixed(4) : "not set"}`,
    ``,
    `Partial close history:`,
    partialsSection,
    ``,
    `Version B comparison (same symbol, same period):`,
    versionBStr,
    ``,
    `Reflect honestly. Be specific about named signals. No generic advice. Return ONLY valid JSON:`,
    `{"entryQuality":"good|ok|poor","directionCorrect":true,"entryTiming":"early|middle|late",`,
    `"slPlacement":"good|too_tight|too_wide","tpRealism":"good|too_tight|too_ambitious",`,
    `"sizingCorrect":true,"partialsCorrect":true,"marketContextCorrect":true,`,
    `"mistakeType":"wrong_direction|late_entry|stop_too_tight|stop_too_wide|chasing_extended_move|gave_back_profits|cut_winner_early|position_review_interference|stale_metadata_bug|correct_but_unlucky|null",`,
    `"signalsThatWorked":["specific signal name"],"signalsThatFailed":["specific signal name"],`,
    `"versionBLesson":"string or null","whatWorked":"string","whatDidnt":"string",`,
    `"lessonsLearned":"one concrete insight","nextTimeWouldDo":"one specific change"}`,
  ].filter(s => s !== null && s !== undefined).join("\n");

  type R = {
    entryQuality: string; directionCorrect: boolean; entryTiming: string;
    slPlacement: string; tpRealism: string; sizingCorrect: boolean;
    partialsCorrect: boolean | string; marketContextCorrect: boolean;
    mistakeType: string | null; signalsThatWorked: string[];
    signalsThatFailed: string[]; versionBLesson: string | null;
    whatWorked: string; whatDidnt: string; lessonsLearned: string; nextTimeWouldDo: string;
  };

  const res = await llm.json<R>({
    taskType:      "assistant_reply",
    systemContext: "You are a trading journal assistant. Reply JSON only. Be specific about signal names and prices. No markdown, no generic advice.",
    prompt,
    schema: {
      type: "object",
      required: ["entryQuality", "directionCorrect", "entryTiming", "slPlacement", "tpRealism",
                 "sizingCorrect", "partialsCorrect", "marketContextCorrect",
                 "signalsThatWorked", "signalsThatFailed", "whatWorked", "whatDidnt",
                 "lessonsLearned", "nextTimeWouldDo"],
      properties: {
        entryQuality:         { type: "string" },
        directionCorrect:     { type: "boolean" },
        entryTiming:          { type: "string" },
        slPlacement:          { type: "string" },
        tpRealism:            { type: "string" },
        sizingCorrect:        { type: "boolean" },
        partialsCorrect:      {},
        marketContextCorrect: { type: "boolean" },
        mistakeType:          {},
        signalsThatWorked:    { type: "array", items: { type: "string" } },
        signalsThatFailed:    { type: "array", items: { type: "string" } },
        versionBLesson:       {},
        whatWorked:           { type: "string" },
        whatDidnt:            { type: "string" },
        lessonsLearned:       { type: "string" },
        nextTimeWouldDo:      { type: "string" },
      },
    },
    fallback: {
      entryQuality: "ok", directionCorrect: true, entryTiming: "middle",
      slPlacement: "good", tpRealism: "good", sizingCorrect: true, partialsCorrect: "na",
      marketContextCorrect: true, mistakeType: null,
      signalsThatWorked: [], signalsThatFailed: [],
      versionBLesson: null, whatWorked: "", whatDidnt: "", lessonsLearned: "", nextTimeWouldDo: "",
    },
  });

  const d = res.data;
  const outcome    = input.pnl >= 0 ? "WIN" : "LOSS";
  const reflection = [
    `${input.direction.toUpperCase()} ${outcome} ${sign}${input.pnlPct.toFixed(2)}%`,
    d.mistakeType && d.mistakeType !== "null" ? `mistake=${d.mistakeType}` : null,
    d.lessonsLearned || null,
  ].filter(Boolean).join(" | ");

  await db.insert(tradeMemoryTable).values({
    symbol:               input.symbol,
    action:               "TRADE_CLOSE",
    pnlPct:               String(input.pnlPct.toFixed(4)),
    reflection,
    entryQuality:         String(d.entryQuality),
    directionCorrect:     String(d.directionCorrect),
    entryTiming:          d.entryTiming          || null,
    slPlacement:          d.slPlacement          || null,
    tpRealism:            d.tpRealism            || null,
    sizingCorrect:        String(d.sizingCorrect),
    partialsCorrect:      String(d.partialsCorrect),
    marketContextCorrect: String(d.marketContextCorrect),
    mistakeType:          (d.mistakeType && d.mistakeType !== "null") ? d.mistakeType : null,
    signalsThatWorked:    JSON.stringify(d.signalsThatWorked || []),
    signalsThatFailed:    JSON.stringify(d.signalsThatFailed || []),
    versionBLesson:       d.versionBLesson       || null,
    whatWorked:           d.whatWorked           || null,
    whatDidnt:            d.whatDidnt            || null,
    lessonsLearned:       d.lessonsLearned       || null,
    nextTimeWouldDo:      d.nextTimeWouldDo      || null,
  });

  console.log(`[tradeMemory] ${input.symbol} reflection stored — ${outcome} ${sign}${input.pnlPct.toFixed(2)}% mistake=${d.mistakeType ?? "none"}`);
}

// ─── Partial close logger ─────────────────────────────────────────────────────

export async function logPartialClose(params: {
  symbol:       string;
  partialType:  "tp1" | "tp2" | "large_profit" | "review";
  closePct:     number;
  priceAtClose: number;
  pnlPct:       number;
  remainingPct: number;
}): Promise<void> {
  const { symbol, partialType, closePct, priceAtClose, pnlPct, remainingPct } = params;
  const sign = pnlPct >= 0 ? "+" : "";
  await db.insert(tradeMemoryTable).values({
    symbol,
    action:       "PARTIAL",
    partialType,
    closePct:     String(closePct),
    priceAtClose: String(priceAtClose.toFixed(4)),
    remainingPct: String(remainingPct),
    pnlPct:       String(pnlPct.toFixed(4)),
    reflection:   `PARTIAL ${partialType.toUpperCase()}: closed ${closePct}% at $${priceAtClose.toFixed(4)} (${sign}${pnlPct.toFixed(2)}%), ${remainingPct}% remaining`,
  }).catch(e => console.error("[tradeMemory] logPartialClose failed:", e));
}

// ─── Recent memory for scan prompt ───────────────────────────────────────────

export async function getRecentMemory(limit = 15): Promise<string> {
  const rows = await db.select()
    .from(tradeMemoryTable)
    .orderBy(desc(tradeMemoryTable.createdAt))
    .limit(limit + 10);

  // All TRADE_CLOSE entries for pattern analysis
  const allCloses = await db.select({
    directionCorrect:     tradeMemoryTable.directionCorrect,
    entryTiming:          tradeMemoryTable.entryTiming,
    slPlacement:          tradeMemoryTable.slPlacement,
    tpRealism:            tradeMemoryTable.tpRealism,
    mistakeType:          tradeMemoryTable.mistakeType,
    entryQuality:         tradeMemoryTable.entryQuality,
    pnlPct:               tradeMemoryTable.pnlPct,
  }).from(tradeMemoryTable)
    .where(eq(tradeMemoryTable.action, "TRADE_CLOSE"))
    .orderBy(desc(tradeMemoryTable.createdAt))
    .limit(50)
    .catch(() => [] as Array<Record<string, string | null>>);

  if (!rows.length) return "No trade memory available yet.";

  const lines: string[] = ["═══ TRADING LESSONS FROM HISTORY ═══\n"];

  // ── Recent trade closes ──
  const closes = rows.filter(r => r.action === "TRADE_CLOSE").slice(0, limit);
  if (closes.length) {
    lines.push("Recent closed trades:");
    for (const r of closes) {
      const pct  = r.pnlPct ? parseFloat(r.pnlPct) : 0;
      const sign = pct >= 0 ? "+" : "";
      const outcome = pct >= 0 ? "WIN" : "LOSS";
      lines.push(`━━━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`${r.symbol} ${r.directionCorrect === "false" ? "⚠️wrong-dir" : ""} | ${sign}${pct.toFixed(2)}% | ${outcome}`);
      if (r.entryQuality)
        lines.push(`  Entry: ${r.entryQuality} | Timing: ${r.entryTiming ?? "?"} | Dir: ${r.directionCorrect === "true" ? "✓" : "✗"} | SL: ${r.slPlacement ?? "?"} | TP: ${r.tpRealism ?? "?"}`);
      if (r.mistakeType)
        lines.push(`  Mistake: ${r.mistakeType}`);
      if (r.whatWorked)
        lines.push(`  Worked: ${r.whatWorked}`);
      if (r.whatDidnt)
        lines.push(`  Failed: ${r.whatDidnt}`);
      if (r.lessonsLearned)
        lines.push(`  Lesson: ${r.lessonsLearned}`);
      if (r.nextTimeWouldDo)
        lines.push(`  Next: ${r.nextTimeWouldDo}`);
      if (r.versionBLesson)
        lines.push(`  Version B: ${r.versionBLesson}`);
    }
  }

  // ── Recent partials ──
  const partials = rows.filter(r => r.action === "PARTIAL").slice(0, 4);
  if (partials.length) {
    lines.push(`\nRecent partial closes:`);
    for (const r of partials) {
      lines.push(`━━━━━━━━━━━━━━━━━━━━━━`);
      lines.push(r.reflection);
    }
  }

  // ── Pattern analysis ──
  if (allCloses.length > 0) {
    const total      = allCloses.length;
    const wrongDir   = allCloses.filter(r => r.directionCorrect === "false").length;
    const lateEntry  = allCloses.filter(r => r.entryTiming === "late").length;
    const tightSL    = allCloses.filter(r => r.slPlacement === "too_tight").length;
    const wins       = allCloses.filter(r => parseFloat(r.pnlPct ?? "0") > 0).length;

    const mistakeCounts: Record<string, number> = {};
    for (const r of allCloses) {
      if (r.mistakeType) mistakeCounts[r.mistakeType] = (mistakeCounts[r.mistakeType] ?? 0) + 1;
    }
    const topMistakes = Object.entries(mistakeCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k}(${v})`).join(", ");

    lines.push(`\n═══ PATTERNS IDENTIFIED ═══`);
    lines.push(`Overall: ${wins}/${total} win rate (${Math.round(wins / total * 100)}%)`);
    lines.push(`Wrong direction: ${wrongDir}/${total} (${Math.round(wrongDir / total * 100)}%)`);
    lines.push(`Late entries: ${lateEntry}/${total} (${Math.round(lateEntry / total * 100)}%)`);
    lines.push(`Stop too tight: ${tightSL}/${total} (${Math.round(tightSL / total * 100)}%)`);
    if (topMistakes) lines.push(`Top mistakes: ${topMistakes}`);
    lines.push(`\nAPPLY THESE LESSONS NOW. Do not repeat identified mistakes.`);
  }

  return lines.join("\n");
}

// ─── Startup backfill ─────────────────────────────────────────────────────────

export async function backfillStructuredReflections(max = 20): Promise<void> {
  const closedTrades = await db.select()
    .from(tradeLogTable)
    .where(isNotNull(tradeLogTable.exitAt))
    .orderBy(asc(tradeLogTable.entryAt))
    .catch(() => [] as Array<typeof tradeLogTable.$inferSelect>);

  let processed = 0;
  for (const trade of closedTrades) {
    if (processed >= max) break;

    // Check if a structured reflection already exists within ±2h of this trade's exit time
    // (match by exit time, not just symbol — handles multiple trades per symbol)
    const exitMs        = trade.exitAt ? new Date(trade.exitAt).getTime() : 0;
    const windowStart   = new Date(exitMs - 2 * 60 * 60 * 1000);
    const windowEnd     = new Date(exitMs + 2 * 60 * 60 * 1000);
    const existing = exitMs > 0
      ? await db.select({ id: tradeMemoryTable.id, createdAt: tradeMemoryTable.createdAt })
          .from(tradeMemoryTable)
          .where(and(
            eq(tradeMemoryTable.symbol, trade.symbol),
            eq(tradeMemoryTable.action, "TRADE_CLOSE"),
            isNotNull(tradeMemoryTable.entryTiming),
            gte(tradeMemoryTable.createdAt, windowStart),
            lte(tradeMemoryTable.createdAt, windowEnd),
          ))
          .limit(1)
          .catch(() => [] as Array<{ id: string; createdAt: Date }>)
      : [];

    if (existing.length > 0) continue;

    // Delete any old-format reflection in the same window (missing entryTiming)
    if (exitMs > 0) {
      await db.delete(tradeMemoryTable)
        .where(and(
          eq(tradeMemoryTable.symbol, trade.symbol),
          eq(tradeMemoryTable.action, "TRADE_CLOSE"),
          isNull(tradeMemoryTable.entryTiming),
          gte(tradeMemoryTable.createdAt, windowStart),
          lte(tradeMemoryTable.createdAt, windowEnd),
        ))
        .catch(() => {});
    }

    const entryPrice = parseFloat(trade.entryPrice ?? "0");
    const exitPrice  = parseFloat(trade.exitPrice  ?? "0");
    const pnl        = parseFloat(trade.pnl  ?? "0");
    const pnlPct     = parseFloat(trade.pnlPct ?? "0");

    if (!entryPrice || !exitPrice) {
      console.log(`[backfill] ${trade.symbol} — skipping (missing prices)`);
      continue;
    }

    console.log(`[backfill] Generating reflection for ${trade.symbol} ${trade.direction} ${pnlPct >= 0 ? "WIN" : "LOSS"} ${pnlPct.toFixed(2)}%`);

    await generateReflection({
      symbol:    trade.symbol,
      direction: trade.direction,
      entryPrice,
      exitPrice,
      pnl,
      pnlPct,
      reasoning: trade.reasoning ?? undefined,
      entryAt:   trade.entryAt,
      exitAt:    trade.exitAt,
      setupType: trade.setupType,
      score:     trade.score,
      whyNow:    trade.whyNow,
      sl:        trade.sl,
      tp1:       trade.tp1,
      tp2:       trade.tp2,
    }).catch(e => console.error(`[backfill] ${trade.symbol} reflection failed:`, (e as Error).message));

    processed++;
    await sleep(1500); // rate limit Claude API
  }

  console.log(`[backfill] Done — ${processed} reflections generated`);
}

// ─── Utility queries ──────────────────────────────────────────────────────────

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
  const rows = await db.select({ pnl: tradeLogTable.pnl })
    .from(tradeLogTable)
    .where(isNotNull(tradeLogTable.exitAt));
  return rows.reduce((sum, r) => sum + parseFloat(r.pnl ?? "0"), 0);
}

export async function logOpenTrade(params: {
  symbol: string; broker: string; direction: "long" | "short";
  entryPrice: number; leverage: number; amountUsd: number; reasoning?: string;
  stopLoss?: number; takeProfit?: number; stopLossMethod?: string;
}): Promise<void> {
  const enriched = [
    params.reasoning,
    params.stopLoss       ? `SL=$${params.stopLoss}`          : null,
    params.takeProfit     ? `TP=$${params.takeProfit}`         : null,
    params.stopLossMethod ? `method=${params.stopLossMethod}`  : null,
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
  symbol:              string;
  broker:              string;
  exitPrice:           number;
  amountUsd:           number;
  pnlOverride?:        number;
  entryPriceOverride?: number;
  directionOverride?:  "long" | "short";
}): Promise<void> {
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

  const entryPrice = params.entryPriceOverride ?? parseFloat(openTrade.entryPrice ?? "0");
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

  await db.update(tradeLogTable)
    .set({
      exitPrice:  params.exitPrice > 0 ? String(params.exitPrice) : openTrade.exitPrice,
      entryPrice: String(entryPrice),
      pnl:        String(pnl.toFixed(4)),
      pnlPct:     String(pnlPct.toFixed(4)),
      exitAt:     new Date(),
    })
    .where(eq(tradeLogTable.id, openTrade.id));

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
    entryAt:   openTrade.entryAt,
    exitAt:    new Date(),
    setupType: openTrade.setupType,
    score:     openTrade.score,
    whyNow:    openTrade.whyNow,
    sl:        openTrade.sl,
    tp1:       openTrade.tp1,
    tp2:       openTrade.tp2,
  }).catch(e => console.error("[tradeMemory] reflection failed:", e));
}
