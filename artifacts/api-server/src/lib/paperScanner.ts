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
  getFundingRate,
  getOpenInterest,
  getPositions as bybitGetPositions,
  type BybitKline,
} from "../brokers/bybit";
import { getRecentMemory, getPerformanceSummary } from "./tradeMemoryLib";
import { llm }                   from "./llmRouter";
import { db, profileTable, paperTradesTable, botStateTable } from "@workspace/db";
import { eq, gt, and } from "drizzle-orm";

const PAPER_STARTING_BALANCE = 40.0;

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
      db.select().from(profileTable).limit(1).then(r => r[0]),
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

    const marginSize = Math.max(5, paperBalance * 0.05);
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
      "IMPORTANT: All JSON string values must be valid JSON. No unescaped double quotes inside strings — use single quotes if quoting within text. No literal newlines inside strings. Keep reasoning under 80 words.",
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
    let runningBalance = paperBalance;

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
    const cutoff = new Date(Date.now() - 14 * 24 * 3600_000); // 14 days
    const open   = await db
      .select()
      .from(paperTradesTable)
      .where(and(
        eq(paperTradesTable.status, "open"),
        gt(paperTradesTable.signalTime, cutoff),
      ));

    if (!open.length) return;

    for (const trade of open) {
      try {
        const sym      = `${trade.symbol}USDT`.replace(/USDTUSDT$/, "USDT");
        const klines   = await getKlines(sym, "60", 1).catch(() => [] as BybitKline[]);
        const current  = klines.at(-1)?.close ?? 0;
        if (!current) continue;

        const entry    = trade.entryPrice;
        const isLong   = trade.direction === "long";
        const pnlPct   = isLong
          ? (current - entry) / entry * 100
          : (entry - current) / entry * 100;

        let newStatus = "open";
        let exitPrice: number | null = null;
        const now = new Date();

        if (trade.stopLoss && (isLong ? current <= trade.stopLoss : current >= trade.stopLoss)) {
          newStatus = "stopped_out";
          exitPrice = trade.stopLoss;
        } else if (trade.tp2 && (isLong ? current >= trade.tp2 : current <= trade.tp2)) {
          newStatus = "tp2_hit";
          exitPrice = trade.tp2;
        } else if (trade.tp1 && (isLong ? current >= trade.tp1 : current <= trade.tp1)) {
          newStatus = "tp1_hit";
          exitPrice = trade.tp1;
        }

        const finalPct = exitPrice
          ? (isLong ? (exitPrice - entry) / entry : (entry - exitPrice) / entry) * 100
          : pnlPct;

        const realizedPnl = exitPrice
          ? (trade.marginUsed ?? 5) * 10 * (finalPct / 100)  // 10x leverage
          : null;

        await db.update(paperTradesTable).set({
          wouldHavePnl:    finalPct * (trade.marginUsed ?? 5) * 10 / 100,
          wouldHavePnlPct: finalPct,
          ...(newStatus !== "open" ? { status: newStatus, exitPrice, exitTime: now } : {}),
        }).where(eq(paperTradesTable.id, trade.id));

        // Return margin + realized PnL to paper balance on close
        if (newStatus !== "open" && trade.marginUsed) {
          const bal = await getPaperBalance();
          const returned = trade.marginUsed + (realizedPnl ?? 0);
          await setPaperBalance(Math.max(0, bal + returned))
            .catch(e => console.warn("[paperScanner] balance return:", e.message));
        }
      } catch { /* skip individual trade errors */ }
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
      `<i>Run /paperhistory for full signal log</i>`,
    ].filter(line => line !== undefined).join("\n");

    await alertFn(lines);
  } catch (err) {
    console.error("[paperScanner] Weekly report failed:", err);
  }
}

// ── Sunday 9am SGT = 1am UTC weekly cron ─────────────────────────────────────

export function startWeeklyAbReportCron(alertFn: (msg: string) => Promise<void>): void {
  // 0 1 * * 0 = every Sunday at 01:00 UTC (= 09:00 SGT)
  cron.schedule("0 1 * * 0", () => {
    void sendWeeklyAbReport(alertFn).catch(e => console.error("[paperScanner] Weekly cron:", e));
  });
  console.log("[paperScanner] Weekly A/B report cron scheduled (Sun 09:00 SGT)");
}
