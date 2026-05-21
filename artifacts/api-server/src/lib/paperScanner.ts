/**
 * paperScanner.ts — Version B paper trading (A/B test)
 *
 * Runs the same market scan as Version A but with no regime/score/filter blocks.
 * Claude decides freely. Results are logged to paper_trades — never executed.
 */

import { detectMarketRegime, type ScanOpportunity, type ScanResult } from "./marketScanner";
import { getWatchlist }          from "./watchlist";
import { fetchAssetData }        from "../data/marketData";
import {
  getKlines,
  getTicker,
  getFundingRate,
  getOpenInterest,
  getPositions as bybitGetPositions,
  type BybitKline,
} from "../brokers/bybit";
import { getRecentMemory, getPerformanceSummary, getActiveRules } from "./tradeMemoryLib";
import { llm }                   from "./llmRouter";
import { db, profileTable, paperTradesTable, botStateTable, tradeMemoryTable, ruleOverridesTable } from "@workspace/db";
import { eq, gt, and, isNull, isNotNull } from "drizzle-orm";
import { backfillStructuredReflections } from "./tradeMemoryLib";

const PAPER_STARTING_BALANCE = 40.0;

// ── Profile cache — refreshed once per process lifetime ──────────────────────
let _profileCache: { totalCapital?: number | null } | null = null;
async function getCachedProfile() {
  if (_profileCache) return _profileCache;
  const rows = await db.select().from(profileTable).limit(1);
  _profileCache = rows[0] ?? {};
  return _profileCache;
}

async function getPaperBalance(): Promise<number> {
  const [row] = await db.select({ paperBalance: botStateTable.paperBalance })
    .from(botStateTable).limit(1);
  return row?.paperBalance ?? PAPER_STARTING_BALANCE;
}

async function setPaperBalance(balance: number): Promise<void> {
  await db.update(botStateTable)
    .set({ paperBalance: balance, lastUpdated: new Date() })
    .where(eq(botStateTable.id, 1));
}
import cron from "node-cron";

// ── Market data helpers (mirror of marketScanner internals) ──────────────────

function formatRow(d: { symbol: string; price: number; change7d: number; change30d: number; rsi: number; volume: number }, assetClass: string): string {
  const vol = d.volume > 1e9 ? `${(d.volume / 1e9).toFixed(1)}B`
            : d.volume > 1e6 ? `${(d.volume / 1e6).toFixed(1)}M` : `${d.volume}`;
  return `${d.symbol}|${assetClass}|$${d.price.toFixed(2)}|${d.change7d > 0 ? "+" : ""}${d.change7d}%|${d.change30d > 0 ? "+" : ""}${d.change30d}%|RSI${d.rsi}|${vol}`;
}

async function fetchMTFSummary(symbol: string): Promise<string> {
  const [k1h, k4h, k1d] = await Promise.all([
    getKlines(symbol, "60",    24).catch(() => [] as BybitKline[]),
    getKlines(symbol, "240",   24).catch(() => [] as BybitKline[]),
    getKlines(symbol, "D",     14).catch(() => [] as BybitKline[]),
  ]);
  const last = (ks: BybitKline[]) => ks.at(-1);
  const trend = (ks: BybitKline[]) => {
    if (ks.length < 5) return "?";
    const avg5 = ks.slice(-5).reduce((s, k) => s + k.close, 0) / 5;
    return ks.at(-1)!.close > avg5 ? "up" : "dn";
  };
  const rsi14 = (ks: BybitKline[]) => {
    if (ks.length < 15) return 50;
    let g = 0, l = 0;
    for (let i = 1; i <= 14; i++) {
      const d = ks[ks.length - i]!.close - ks[ks.length - i - 1]!.close;
      if (d > 0) g += d; else l -= d;
    }
    const rs = l === 0 ? 100 : g / l;
    return Math.round(100 - 100 / (1 + rs));
  };
  const l1h = last(k1h), l4h = last(k4h), l1d = last(k1d);
  return `1h=${trend(k1h)}(RSI${rsi14(k1h)}) 4h=${trend(k4h)}(RSI${rsi14(k4h)}) 1D=${trend(k1d)} price=${l1h?.close.toFixed(2) ?? l4h?.close.toFixed(2) ?? "?"}`;
}

// ── Core paper scan ──────────────────────────────────────────────────────────

export async function runPaperScan(): Promise<void> {
  console.log("[paperScanner] Version B scan starting…");
  try {
    const [regime, watchlist, profile, bybitPositions, tradeMemory, perfSummary] = await Promise.all([
      detectMarketRegime(),
      getWatchlist(),
      getCachedProfile(),
      bybitGetPositions().catch(() => []),
      getRecentMemory(20).catch(() => ""),
      getPerformanceSummary().catch(() => ""),
    ]);

    const classMap = Object.fromEntries(watchlist.map(e => [e.symbol, e.assetClass]));
    const cryptoEntries = watchlist.filter(e => e.assetClass === "Crypto");

    // Fetch asset data + market context in parallel
    const assetResults = await Promise.allSettled(
      cryptoEntries.map(e => fetchAssetData(e.symbol, e.assetClass))
    );
    const assetData = assetResults
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchAssetData>>> => r.status === "fulfilled")
      .map(r => r.value);

    if (assetData.length < 2) {
      console.warn("[paperScanner] Insufficient market data — skipping");
      return;
    }

    const cryptoSyms = cryptoEntries.slice(0, 5).map(e => e.symbol);
    const mtfLines:     string[] = [];
    const fundingLines: string[] = [];

    for (const sym of cryptoSyms) {
      try {
        const [mtf, fr, oi] = await Promise.all([
          fetchMTFSummary(sym),
          getFundingRate(sym).catch(() => ({ rate: 0, nextFundingTime: 0 })),
          getOpenInterest(sym).catch(() => 0),
        ]);
        mtfLines.push(`${sym} MTF: ${mtf}`);
        const rSign = fr.rate >= 0 ? "+" : "";
        fundingLines.push(`${sym} fundingRate=${rSign}${(fr.rate * 100).toFixed(4)}% OI=${oi > 1e9 ? `${(oi/1e9).toFixed(2)}B` : oi > 1e6 ? `${(oi/1e6).toFixed(1)}M` : oi.toFixed(0)}`);
      } catch { /* skip */ }
    }

    const bybitPosSummary = bybitPositions.length
      ? bybitPositions.map(p => `${p.symbol} ${p.side} pnl=${p.pnlPct.toFixed(1)}%`).join(", ")
      : "none";

    const paperBalance = await getPaperBalance();

    if (paperBalance < 5) {
      console.log(`[paperTrade] Paper balance $${paperBalance.toFixed(2)} below $5 minimum — stopped`);
      return;
    }

    const tableRows  = assetData.map(d => formatRow(d, classMap[d.symbol] ?? "Crypto"));

    // ── Version B system prompt — no regime/score blocks ────────────────────
    const systemContext = [
      "You are an experimental trading bot — Version B. Respond with ONLY valid JSON — no markdown, no prose.",
      `Schema: {"opportunities":[{"symbol":"","assetClass":"","score":0-100,"recommendation":"STRONG BUY|BUY|STRONG SELL|SELL|WATCH|AVOID","reasoning":"","price":0,"dataTimestamp":"","direction":"long|short|neutral","conviction":"low|medium|high|strong_buy|strong_sell","entry":0,"stopLoss":0,"takeProfit":0,"atr":0,"tp1":0,"tp2":0,"leverage":1,"positionSizeUsd":0,"orderType":"market|limit","riskRewardRatio":0,"stopLossMethod":"swing_low|ATR|percent|support","setupType":"REJECTION|MOMENTUM|OVEREXTENDED|LIQUIDITY_SWEEP","setupQuality":"HIGH|MEDIUM|LOW","timing":"EARLY|MIDDLE|LATE","whyNow":"","edgeType":"LIQUIDITY_TRAP|SQUEEZE_SETUP|RELATIVE_WEAKNESS|SWEEP_REVERSAL|TREND_CONTINUATION|MEAN_REVERSION","conflicts":[],"conflictResolution":"NO_CONFLICT|MINOR_REDUCED|MAJOR_SKIP","sweepDetected":false,"squeezeDetected":false,"relativeStrengthVsBtc":0,"rMultiple":0}],"scanTimestamp":"","summary":""}`,
      "You have access to all market data: RSI, EMA, ADX, funding, OI, volume, relative strength, all timeframes.",
      "You are NOT told which signals to use. Discover your own signal combinations.",
      "Document which signals you chose and why in the 'reasoning' field.",
      "Hard limits only:",
      "  - Max stop loss: 40% from entry",
      "  - $5 minimum per trade",
      `Everything else is your judgment. Experiment freely — this is paper trading with $${paperBalance.toFixed(2)} balance.`,
      "Regime is informational only — not a block.",
      "Score is informational only — no threshold. Rank 5 opportunities freely.",
      "Include at least 1-2 short signals if bearish setups exist.",
      "For LONGS: stopLoss below entry, tp1/tp2 above. For SHORTS: stopLoss above entry, tp1/tp2 below.",
      "riskRewardRatio must be ≥1.0. ATR-based: TP1=entry±(ATR×1.0), TP2=entry±(ATR×2.0), SL=entry±(ATR×1.5).",
      "whyNow: name the specific signals you chose to use and why you preferred them over others. If no edge — set direction=neutral.",
      "CRITICAL JSON RULES: reasoning max 60 chars. whyNow max 40 chars. summary max 80 chars. NEVER use double-quote characters inside any string value. NEVER use backslash characters. Use only plain ASCII letters, digits, spaces, and these safe chars: . , - + % : / ( ). No newlines inside strings.",
    ].join("\n");

    const prompt = [
      `Bybit live positions: ${bybitPosSummary}`,
      `UTC: ${new Date().toISOString()}`,
      ``,
      `Market regime (informational only — not a block):`,
      `  ${regime.regime} | ADX=${regime.adx.toFixed(1)} DI+=${regime.diPlus.toFixed(1)} DI-=${regime.diMinus.toFixed(1)}`,
      `  ATR=$${regime.atr.toFixed(0)} (${regime.atrAvg30d > 0 ? (regime.atr / regime.atrAvg30d).toFixed(1) : "?"}× 30d avg)`,
      `  Note: ${regime.summary}`,
      ``,
      mtfLines.length   ? `Multi-timeframe data:\n${mtfLines.join("\n")}\n`   : "",
      fundingLines.length ? `Funding rates & open interest:\n${fundingLines.join("\n")}\n` : "",
      `Market snapshot (Symbol|Class|Price|7d%|30d%|RSI|Volume):`,
      tableRows.join("\n"),
      ``,
      tradeMemory ? `Trade memory (last 20 reflections):\n${tradeMemory}` : "",
      perfSummary ? `\n${perfSummary}` : "",
    ].filter(Boolean).join("\n");

    const res = await llm.json<ScanResult>({
      taskType:      "market_scan",
      systemContext,
      prompt,
      schema: {
        type: "object",
        properties: {
          opportunities: { type: "array" },
          scanTimestamp: { type: "string" },
          summary:       { type: "string" },
        },
        required: ["opportunities", "scanTimestamp", "summary"],
      },
      fallback: { opportunities: [], scanTimestamp: new Date().toISOString(), summary: "" },
    });

    if (!res.parseSuccess || !res.data.opportunities?.length) {
      console.warn("[paperScanner] No valid opportunities returned");
      return;
    }

    // ── Log non-neutral signals to paper_trades (never execute) ─────────────
    let logged = 0;

    // Deduct margin already locked in open paper trades before accepting new ones
    const openPaperTrades = await db.select({ id: paperTradesTable.id })
      .from(paperTradesTable)
      .where(eq(paperTradesTable.status, "open"))
      .catch(() => [] as Array<{ id: string }>);
    const marginInUse   = openPaperTrades.length * Math.max(5, paperBalance * 0.05);
    const availableBalance = paperBalance - marginInUse;
    if (availableBalance < 5) {
      console.log(`[paperTrade] Insufficient paper balance ($${availableBalance.toFixed(2)} available, ${openPaperTrades.length} open trades using $${marginInUse.toFixed(2)}) — skip`);
      return;
    }
    let runningBalance = availableBalance;

    for (const sig of res.data.opportunities as ScanOpportunity[]) {
      if (!sig.direction || sig.direction === "neutral") continue;
      if (!sig.entry || sig.entry <= 0) continue;

      if (runningBalance < 5) {
        console.log(`[paperTrade] Paper balance $${runningBalance.toFixed(2)} below $5 minimum — stopped`);
        break;
      }

      const tradeMargin = Math.max(5, runningBalance * 0.05);
      runningBalance -= tradeMargin;

      await db.insert(paperTradesTable).values({
        symbol:    sig.symbol,
        direction: sig.direction,
        entryPrice: sig.entry ?? sig.price,
        stopLoss:  sig.stopLoss   ?? null,
        tp1:       sig.tp1        ?? null,
        tp2:       sig.tp2        ?? null,
        rr:        sig.riskRewardRatio ?? null,
        regime:    regime.regime,
        score:     sig.score      ?? null,
        whyNow:    sig.whyNow     ?? null,
        setupType: sig.setupType  ?? null,
        signalTime: new Date(),
        status:    "open",
        version:   "B",
        marginUsed: tradeMargin,
      }).catch(e => console.warn(`[paperScanner] DB insert ${sig.symbol}:`, e.message));

      console.log(
        `[paperTrade] Version B would enter: ${sig.symbol} ${sig.direction} ` +
        `at $${sig.entry} margin=$${tradeMargin.toFixed(2)} balance=$${runningBalance.toFixed(2)} score=${sig.score} regime=${regime.regime}`
      );
      logged++;
    }

    if (runningBalance !== paperBalance) {
      await setPaperBalance(runningBalance).catch(e => console.warn("[paperScanner] balance update:", e.message));
    }

    console.log(`[paperScanner] Version B complete — ${logged} signals logged, balance=$${runningBalance.toFixed(2)} (${res.data.opportunities.length} total)`);
  } catch (err) {
    console.error("[paperScanner] Scan failed:", err);
  }
}

// ── Paper trade P/L updater (called from position monitor) ───────────────────

export async function updatePaperTradesPnl(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 14 * 24 * 3600_000);
    const open   = await db
      .select()
      .from(paperTradesTable)
      .where(and(eq(paperTradesTable.status, "open"), gt(paperTradesTable.signalTime, cutoff)));

    console.log(`[paperMonitor] Checking ${open.length} open paper trades`);
    if (!open.length) return;

    // Fetch live last price for each unique symbol
    const uniqueSyms = [...new Set(open.map(t => `${t.symbol}USDT`.replace(/USDTUSDT$/, "USDT")))];
    const priceMap = new Map<string, number>();
    await Promise.allSettled(uniqueSyms.map(async sym => {
      const price = await getTicker(sym).then(t => t.lastPrice).catch(() => 0);
      if (price) priceMap.set(sym, price);
    }));

    // Process all trades, accumulate balance returns for one final DB write
    const now = new Date();
    let totalBalanceReturn = 0;

    for (const trade of open) {
      try {
        const sym     = `${trade.symbol}USDT`.replace(/USDTUSDT$/, "USDT");
        const current = priceMap.get(sym);
        if (!current) continue;

        const entry   = trade.entryPrice;
        const isLong  = trade.direction === "long";
        const pnlPct  = isLong ? (current - entry) / entry * 100 : (entry - current) / entry * 100;

        console.log(`[paperMonitor] ${trade.symbol} ${trade.direction} entry=${entry} price=${current} tp1=${trade.tp1 ?? "—"} sl=${trade.stopLoss ?? "—"} pnl%=${pnlPct.toFixed(2)}`);

        let newStatus = "open";
        let exitPrice: number | null = null;

        if      (trade.stopLoss && (isLong ? current <= trade.stopLoss : current >= trade.stopLoss)) { newStatus = "stopped_out"; exitPrice = trade.stopLoss; }
        else if (trade.tp2      && (isLong ? current >= trade.tp2      : current <= trade.tp2))      { newStatus = "tp2_hit";    exitPrice = trade.tp2; }
        else if (trade.tp1      && (isLong ? current >= trade.tp1      : current <= trade.tp1))      { newStatus = "tp1_hit";    exitPrice = trade.tp1; }

        const finalPct     = exitPrice ? (isLong ? (exitPrice - entry) / entry : (entry - exitPrice) / entry) * 100 : pnlPct;
        const realizedPnl  = exitPrice ? (trade.marginUsed ?? 5) * 10 * (finalPct / 100) : null;

        await db.update(paperTradesTable).set({
          wouldHavePnl:    finalPct * (trade.marginUsed ?? 5) * 10 / 100,
          wouldHavePnlPct: finalPct,
          ...(newStatus !== "open" ? { status: newStatus, exitPrice, exitTime: now } : {}),
        }).where(eq(paperTradesTable.id, trade.id));

        // Accumulate balance return — write once after loop
        if (newStatus !== "open" && trade.marginUsed) {
          totalBalanceReturn += trade.marginUsed + (realizedPnl ?? 0);
        }
      } catch { /* skip individual trade errors */ }
    }

    // Single balance update for all closed trades this cycle
    if (totalBalanceReturn !== 0) {
      const bal = await getPaperBalance();
      await setPaperBalance(Math.max(0, bal + totalBalanceReturn))
        .catch(e => console.warn("[paperScanner] balance return:", e.message));
    }
  } catch (err) {
    console.error("[paperScanner] P/L update failed:", err);
  }
}

// ── Weekly A/B comparison report ─────────────────────────────────────────────

export async function sendWeeklyAbReport(alertFn: (msg: string) => Promise<void>): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600_000);

    // Version B stats
    const bTrades = await db
      .select()
      .from(paperTradesTable)
      .where(gt(paperTradesTable.signalTime, cutoff));

    const bClosed   = bTrades.filter(t => t.status !== "open");
    const bWins     = bClosed.filter(t => (t.wouldHavePnlPct ?? 0) > 0);
    const bWinRate  = bClosed.length ? Math.round(bWins.length / bClosed.length * 100) : 0;
    const bAvgWin   = bWins.length
      ? bWins.reduce((s, t) => s + (t.wouldHavePnlPct ?? 0), 0) / bWins.length
      : 0;
    const bLosses   = bClosed.filter(t => (t.wouldHavePnlPct ?? 0) <= 0);
    const bAvgLoss  = bLosses.length
      ? bLosses.reduce((s, t) => s + (t.wouldHavePnlPct ?? 0), 0) / bLosses.length
      : 0;
    const bTotalPnl = bClosed.reduce((s, t) => s + (t.wouldHavePnl ?? 0), 0);
    const bAvgRR    = bClosed.filter(t => t.rr).reduce((s, t) => s + (t.rr ?? 0), 0) / (bClosed.filter(t => t.rr).length || 1);

    const reco =
      bWinRate > 65 && bAvgWin > 2   ? "🏆 B better — recommend removing regime blocks" :
      bWinRate < 50 && bAvgLoss < -2 ? "✅ A better — filters adding value" :
                                        "⚖️ Inconclusive — need more data";

    // Learning loop health
    const allCloses = await db.select({
      id:             tradeMemoryTable.id,
      lessonsLearned: tradeMemoryTable.lessonsLearned,
      createdAt:      tradeMemoryTable.createdAt,
    }).from(tradeMemoryTable)
      .where(eq(tradeMemoryTable.action, "TRADE_CLOSE"))
      .catch(() => [] as Array<{ id: string; lessonsLearned: string | null; createdAt: Date }>);

    const totalRef    = allCloses.length;
    const completeRef = allCloses.filter(r => r.lessonsLearned).length;
    const incompleteRef = totalRef - completeRef;
    const completePct = totalRef > 0 ? Math.round(completeRef / totalRef * 100) : 0;
    const lastRef     = allCloses.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.createdAt;
    const lastRefStr  = lastRef ? lastRef.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never";
    const healthFlag  = incompleteRef > totalRef * 0.10 ? "⚠️ Action needed" : "✅ Healthy";

    // Self-improvement: active rules stats
    const activeRules = await getActiveRules().catch(() => [] as Awaited<ReturnType<typeof getActiveRules>>);
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
    const weeklyOverrides = await db.select().from(ruleOverridesTable)
      .where(gt(ruleOverridesTable.createdAt, weekAgo))
      .catch(() => [] as typeof ruleOverridesTable.$inferSelect[]);

    const overrideWins   = weeklyOverrides.filter(o => o.tradeResult === "win").length;
    const overrideLosses = weeklyOverrides.filter(o => o.tradeResult === "loss").length;
    const totalFollowed  = activeRules.reduce((s, r) => s + r.winsFollowing + r.lossesFollowing, 0);
    const totalWins      = activeRules.reduce((s, r) => s + r.winsFollowing, 0);
    const followWinRate  = totalFollowed > 0 ? Math.round(totalWins / totalFollowed * 100) : null;

    const ruleLines: string[] = activeRules.map(r => {
      const tot = r.winsFollowing + r.lossesFollowing;
      const wr  = tot > 0 ? `${Math.round(r.winsFollowing / tot * 100)}%` : "no data";
      const ruleOverrides = weeklyOverrides.filter(o => o.ruleId === r.id);
      const overrideWin  = ruleOverrides.filter(o => o.tradeResult === "win").length;
      const overrideLoss = ruleOverrides.filter(o => o.tradeResult === "loss").length;
      return [
        `Rule ${r.ruleNumber} [${r.confidence}]: ${r.ruleText.slice(0, 60)}`,
        `  Followed: ${tot} times → ${wr} win rate`,
        ruleOverrides.length ? `  Overrides this week: ${ruleOverrides.length} (${overrideWin}W/${overrideLoss}L)` : `  Overrides this week: 0`,
      ].join("\n");
    });

    const lines = [
      `📊 <b>Weekly A/B Test Report</b>`,
      ``,
      `<b>Version A (live, rules-based):</b>`,
      `See /history for live trade results`,
      ``,
      `<b>Version B (paper, Claude decides freely):</b>`,
      `Signals this week: ${bTrades.length} | Closed: ${bClosed.length}`,
      `Win rate: ${bWinRate}% (${bWins.length}/${bClosed.length})`,
      `Would-P/L: ${bTotalPnl >= 0 ? "+" : ""}$${bTotalPnl.toFixed(2)}`,
      `Avg winner: +${bAvgWin.toFixed(2)}% | Avg loser: ${bAvgLoss.toFixed(2)}%`,
      bAvgRR > 0 ? `Avg R:R: 1:${bAvgRR.toFixed(1)}` : "",
      ``,
      `<b>Recommendation:</b> ${reco}`,
      ``,
      `📚 <b>Learning Loop Health:</b>`,
      `Total reflections: ${totalRef} | Complete: ${completeRef} (${completePct}%)`,
      `Incomplete (missing fields): ${incompleteRef}`,
      `Last reflection: ${lastRefStr}`,
      incompleteRef > 0 ? `${healthFlag} — ${incompleteRef} incomplete reflections` : `${healthFlag}`,
      ``,
      `🧠 <b>Self-Improvement Report:</b>`,
      activeRules.length
        ? [
            `Active rules: ${activeRules.length}`,
            followWinRate !== null ? `Overall win rate when rules followed: ${followWinRate}%` : "",
            `This week's overrides: ${weeklyOverrides.length} (${overrideWins}W/${overrideLosses}L)`,
            ``,
            ...ruleLines,
          ].filter(Boolean).join("\n")
        : `No rules yet — generates after 20 closed trades\nUse /rules to check`,
      ``,
      `<i>Run /paperhistory for full signal log | /rules for current rule details</i>`,
    ].filter(line => line !== undefined).join("\n");

    await alertFn(lines);
  } catch (err) {
    console.error("[paperScanner] Weekly report failed:", err);
  }
}

// ── Independent 5-min paper trade monitor ────────────────────────────────────
// Runs regardless of whether the main scan succeeds

export function startPaperMonitorCron(alertFn?: (msg: string) => Promise<void>): void {
  // every 5 minutes
  cron.schedule("*/5 * * * *", () => {
    void updatePaperTradesPnl().catch(e => console.error("[paperMonitor] cron error:", e));
  });

  // Daily midnight SGT (= 16:00 UTC) — learning loop health check
  cron.schedule("0 16 * * *", async () => {
    try {
      const allCloses = await db.select({
        id:             tradeMemoryTable.id,
        lessonsLearned: tradeMemoryTable.lessonsLearned,
      }).from(tradeMemoryTable)
        .where(eq(tradeMemoryTable.action, "TRADE_CLOSE"))
        .catch(() => [] as Array<{ id: string; lessonsLearned: string | null }>);

      const total      = allCloses.length;
      const incomplete = allCloses.filter(r => !r.lessonsLearned).length;

      if (incomplete > 0) {
        console.warn(`[learningHealth] ${incomplete}/${total} reflections incomplete — triggering re-backfill`);
        await alertFn?.(
          `⚠️ <b>Learning loop issue detected</b>\n${incomplete} incomplete reflections found\nTriggering re-backfill…`
        ).catch(() => {});
        backfillStructuredReflections(incomplete + 5).catch(e =>
          console.error("[learningHealth] backfill failed:", e)
        );
      } else {
        console.log(`[learningHealth] All ${total} reflections complete ✅`);
      }
    } catch (e) {
      console.error("[learningHealth] daily check failed:", e);
    }
  });

  console.log("[paperMonitor] Independent 5-min P/L monitor cron started");
  console.log("[learningHealth] Daily midnight SGT learning health check cron started");
}

// ── Sunday 9am SGT = 1am UTC weekly cron ─────────────────────────────────────

export function startWeeklyAbReportCron(alertFn: (msg: string) => Promise<void>): void {
  // 0 1 * * 0 = every Sunday at 01:00 UTC (= 09:00 SGT)
  cron.schedule("0 1 * * 0", () => {
    void sendWeeklyAbReport(alertFn).catch(e => console.error("[paperScanner] Weekly cron:", e));
  });
  console.log("[paperScanner] Weekly A/B report cron scheduled (Sun 09:00 SGT)");
}
