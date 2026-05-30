/**
 * paperScanner.ts — Version B paper trading (A/B test)
 *
 * Runs the same market scan as Version A but with no regime/score/filter blocks.
 * Claude decides freely. Results are logged to paper_trades — never executed.
 */

import { detectMarketRegime, getRegimeThreshold, type ScanOpportunity, type ScanResult } from "./marketScanner";
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
import { getRecentMemory, getPerformanceSummary, getActiveRules, generateReflection } from "./tradeMemoryLib";
import { llm }                   from "./llmRouter";
import { db, profileTable, paperTradesTable, botStateTable, tradeMemoryTable, ruleOverridesTable } from "@workspace/db";
import { eq, gt, and, isNull, isNotNull, sql } from "drizzle-orm";
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

async function addPaperCosts(fees: number, funding: number, slippage: number): Promise<void> {
  if (fees === 0 && funding === 0 && slippage === 0) return;
  await db.update(botStateTable).set({
    ...(fees     > 0 ? { paperTotalFees:     sql`paper_total_fees + ${fees}` }       : {}),
    ...(funding  > 0 ? { paperTotalFunding:  sql`paper_total_funding + ${funding}` } : {}),
    ...(slippage > 0 ? { paperTotalSlippage: sql`paper_total_slippage + ${slippage}` } : {}),
    lastUpdated: new Date(),
  }).where(eq(botStateTable.id, 1))
    .catch(e => console.warn("[paperScanner] cost tracking failed:", e.message));
}

async function getMode3PaperBalance(): Promise<number> {
  const [row] = await db.select({ mode3PaperBalance: botStateTable.mode3PaperBalance })
    .from(botStateTable).limit(1);
  return row?.mode3PaperBalance ?? 40.0;
}

let lastPaperFundingAt    = 0;  // epoch ms — reset on process restart
let _paperAlertFn: ((msg: string) => Promise<void>) | null = null;
let _lastDbWriteAlertAt   = 0;

function dbWriteAlert(context: string, err: unknown): void {
  const now = Date.now();
  if (now - _lastDbWriteAlertAt < 10 * 60_000) return;  // 10-min cooldown
  _lastDbWriteAlertAt = now;
  const msg = err instanceof Error ? err.message : String(err);
  void _paperAlertFn?.(`🚨 DB write failed — check Neon limits\n<b>${context}</b>\n${msg.slice(0, 150)}`).catch(() => {});
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
    const [regime, watchlist, profile, bybitPositions, tradeMemory, perfSummary, activeRules] = await Promise.all([
      detectMarketRegime(),
      getWatchlist(),
      getCachedProfile(),
      bybitGetPositions().catch(() => []),
      getRecentMemory(20).catch(() => ""),
      getPerformanceSummary().catch(() => ""),
      getActiveRules().catch(() => [] as Awaited<ReturnType<typeof getActiveRules>>),
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
      "JSON RULES: NEVER use double-quote characters inside any string value. NEVER use backslash characters. No newlines inside strings.",
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
      activeRules.length ? [
        `\n═══ ACTIVE TRADING RULES (informational — soft rules, not blocks) ═══`,
        ...activeRules.map(r => {
          const tot = r.winsFollowing + r.lossesFollowing;
          const wr  = tot > 0 ? `${Math.round(r.winsFollowing / tot * 100)}%` : "no data";
          return `Rule ${r.ruleNumber} [${r.confidence}]: ${r.ruleText}\n  Logic: ${r.causalLogic ?? "see evidence"} | Track record: ${r.winsFollowing}W/${r.lossesFollowing}L (${wr})`;
        }),
        `You may override any rule — state which rule and why in your reasoning.`,
      ].join("\n") : "",
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

    // ── Fetch open trades for position review ─────────────────────────────────
    const openTrades = await db.select()
      .from(paperTradesTable)
      .where(eq(paperTradesTable.status, "open"))
      .catch(() => [] as typeof paperTradesTable.$inferSelect[]);

    // ── Position review (only when there are open positions) ──────────────────
    interface PortfolioReview {
      positionReviews: Array<{ symbol: string; decision: "HOLD" | "PARTIAL_CLOSE" | "CLOSE"; closePercent: number; newSl?: number; reasoning: string }>;
      newEntries:      Array<{ symbol: string; direction: string; reasoning: string }>;
      portfolioReasoning: string;
    }
    const emptyReview: PortfolioReview = { positionReviews: [], newEntries: [], portfolioReasoning: "" };
    let portfolioDecision  = emptyReview;
    let balanceFromClosures  = 0;
    let totalFeesThisScan    = 0;
    let totalSlippageThisScan = 0;

    if (openTrades.length > 0) {
      // Fetch live prices for open positions
      const openSymbols = [...new Set(openTrades.map(t => `${t.symbol}USDT`.replace(/USDTUSDT$/, "USDT")))];
      const livePrice   = new Map<string, number>();
      await Promise.allSettled(openSymbols.map(async sym => {
        const p = await getTicker(sym).then(t => t.lastPrice).catch(() => 0);
        if (p > 0) livePrice.set(sym, p);
      }));

      // Build position context
      const posLines = openTrades.map(t => {
        const sym    = `${t.symbol}USDT`.replace(/USDTUSDT$/, "USDT");
        const cur    = livePrice.get(sym) ?? t.entryPrice;
        const isLong = t.direction === "long";
        const pnlPct = isLong
          ? (cur - t.entryPrice) / t.entryPrice * 100
          : (t.entryPrice - cur) / t.entryPrice * 100;
        const ageH   = (Date.now() - new Date(t.signalTime as unknown as string).getTime()) / 3_600_000;
        const tp1Dist = t.tp1
          ? `${((isLong ? t.tp1 - cur : cur - t.tp1) / cur * 100).toFixed(1)}% to TP1`
          : "no TP1";
        const leverage = 10;
        const liqEst = isLong
          ? t.entryPrice * (1 - 1 / leverage)
          : t.entryPrice * (1 + 1 / leverage);
        return `${t.symbol} ${t.direction.toUpperCase()} entry=${t.entryPrice} now=${cur.toFixed(4)} pnl=${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% age=${ageH.toFixed(1)}h margin=${(t.marginUsed ?? 5).toFixed(2)} SL=${t.stopLoss ?? "—"} Liq(est)=$${liqEst.toFixed(4)} TP1=${t.tp1 ?? "—"}(${tp1Dist}) TP2=${t.tp2 ?? "—"} | ${t.whyNow ?? "no thesis"}`;
      }).join("\n");

      // New signals summary (give Claude the technical context)
      const newSigLines = (res.data.opportunities as ScanOpportunity[])
        .filter(o => o.direction && o.direction !== "neutral")
        .map(o => `${o.symbol} ${o.direction} score=${o.score ?? "?"} setup=${o.setupType ?? "?"} rr=${o.riskRewardRatio?.toFixed(1) ?? "?"} entry=${o.entry ?? "?"} sl=${o.stopLoss ?? "?"} tp1=${o.tp1 ?? "?"}`)
        .join("\n") || "none";

      const reviewRes = await llm.json<PortfolioReview>({
        taskType: "position_review",
        systemContext: [
          "You are Version B paper trading bot — portfolio manager role. Respond with ONLY valid JSON.",
          "Review each open position: HOLD / PARTIAL_CLOSE / CLOSE.",
          "CLOSE when: thesis broken, price near SL with no recovery, or held >36h flat.",
          "PARTIAL_CLOSE (closePercent=50) when: partial profit makes sense, keep core exposure.",
          "HOLD when: thesis intact, within expected range, let it run.",
          "newSl: optional number — updated stop loss price to secure profit. Longs: only higher than current SL. Shorts: only lower. Omit if no change needed.",
          "newEntries: from the new scan signals, list any you want opened. Empty list is fine.",
          `Capital: paper balance $${paperBalance.toFixed(2)} | Each new entry uses 5% of balance.`,
          "JSON RULES: no double-quotes inside strings, no backslash, no newlines inside strings.",
        ].join("\n"),
        prompt: [
          `=== OPEN POSITIONS (${openTrades.length}) ===`,
          posLines,
          ``,
          `=== NEW SCAN SIGNALS ===`,
          newSigLines,
          ``,
          `Regime: ${regime.regime} | UTC: ${new Date().toISOString()}`,
        ].join("\n"),
        schema: {
          type: "object",
          properties: {
            positionReviews: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  symbol:       { type: "string" },
                  decision:     { type: "string", enum: ["HOLD", "PARTIAL_CLOSE", "CLOSE"] },
                  closePercent: { type: "number" },
                  newSl:        { type: "number" },
                  reasoning:    { type: "string" },
                },
                required: ["symbol", "decision", "reasoning"],
              },
            },
            newEntries:         { type: "array" },
            portfolioReasoning: { type: "string" },
          },
          required: ["positionReviews", "newEntries", "portfolioReasoning"],
        },
        fallback: emptyReview,
      });

      if (reviewRes.parseSuccess) {
        portfolioDecision = reviewRes.data;

        // Execute CLOSE / PARTIAL_CLOSE decisions
        for (const rv of portfolioDecision.positionReviews) {
          const trade = openTrades.find(t =>
            t.symbol === rv.symbol || t.symbol === rv.symbol.replace(/USDT$/, "")
          );
          if (!trade) continue;

          const sym    = `${trade.symbol}USDT`.replace(/USDTUSDT$/, "USDT");
          const cur    = livePrice.get(sym) ?? trade.entryPrice;
          const isLong = trade.direction === "long";
          const pnlPct = isLong
            ? (cur - trade.entryPrice) / trade.entryPrice * 100
            : (trade.entryPrice - cur) / trade.entryPrice * 100;
          const margin = trade.marginUsed ?? 5;
          const pnlUsd = margin * 10 * (pnlPct / 100);

          if (rv.decision?.toUpperCase() === "CLOSE") {
            const closeFee  = margin * 10 * 0.00055;
            const closeTime = new Date();
            await db.update(paperTradesTable).set({
              status:          "closed",
              exitPrice:       cur,
              wouldHavePnl:    pnlUsd,
              wouldHavePnlPct: pnlPct,
              exitTime:        closeTime,
              exitReason:      "claude_close",
            }).where(eq(paperTradesTable.id, trade.id))
              .catch(e => { console.warn(`[paperScanner] CLOSE ${trade.symbol}:`, e.message); dbWriteAlert(`CLOSE ${trade.symbol}`, e); });
            balanceFromClosures += margin + pnlUsd - closeFee;
            totalFeesThisScan   += closeFee;
            console.log(`[paperTrade] Version B CLOSE ${trade.symbol} ${trade.direction} pnl=${pnlPct.toFixed(2)}% returned=$${(margin + pnlUsd - closeFee).toFixed(2)} | ${rv.reasoning.slice(0, 80)}`);
            console.log(`[paperFee] ${trade.symbol} close fee: $${closeFee.toFixed(4)}`);
            generateReflection({
              symbol:        trade.symbol,
              direction:     trade.direction,
              entryPrice:    trade.entryPrice,
              exitPrice:     cur,
              pnl:           pnlUsd,
              pnlPct,
              reasoning:     rv.reasoning,
              entryAt:       trade.signalTime,
              exitAt:        closeTime,
              setupType:     trade.setupType ?? null,
              score:         trade.score != null ? String(trade.score) : null,
              whyNow:        trade.whyNow ?? null,
              sl:            trade.stopLoss != null ? String(trade.stopLoss) : null,
              tp1:           trade.tp1 != null ? String(trade.tp1) : null,
              tp2:           trade.tp2 != null ? String(trade.tp2) : null,
              sourceTradeId: String(trade.id),
              suppressAlerts: true,
              source:        "version_b",
            }).catch(e => console.error(`[paperReflection] CLOSE ${trade.symbol}:`, e.message));

          } else if (rv.decision?.toUpperCase() === "PARTIAL_CLOSE") {
            const pct        = Math.min(Math.max((rv.closePercent ?? 50) / 100, 0.1), 0.9);
            const closedMgn  = margin * pct;
            const closedPnl  = closedMgn * 10 * (pnlPct / 100);
            const closeFee   = closedMgn * 10 * 0.00055;
            await db.update(paperTradesTable).set({
              marginUsed: margin - closedMgn,
              exitReason: "claude_partial",
            }).where(eq(paperTradesTable.id, trade.id))
              .catch(e => { console.warn(`[paperScanner] PARTIAL_CLOSE ${trade.symbol}:`, e.message); dbWriteAlert(`PARTIAL_CLOSE ${trade.symbol}`, e); });
            balanceFromClosures += closedMgn + closedPnl - closeFee;
            totalFeesThisScan   += closeFee;
            console.log(`[paperTrade] Version B PARTIAL_CLOSE ${trade.symbol} ${(pct * 100).toFixed(0)}% pnl=${pnlPct.toFixed(2)}% returned=$${(closedMgn + closedPnl - closeFee).toFixed(2)}`);
            console.log(`[paperFee] ${trade.symbol} close fee: $${closeFee.toFixed(4)}`);
          }
          // newSl: trailing stop — valid on HOLD and PARTIAL_CLOSE (position still open)
          if (rv.decision?.toUpperCase() !== "CLOSE" && rv.newSl != null) {
            if (trade.stopLoss == null) {
              console.warn(`[paperTrade] newSl ignored for ${trade.symbol} — no existing SL to ratchet from`);
            } else {
              const isValid = isLong
                ? rv.newSl > trade.stopLoss   // longs: only ratchet up
                : rv.newSl < trade.stopLoss;  // shorts: only ratchet down
              if (isValid) {
                await db.update(paperTradesTable).set({ stopLoss: rv.newSl })
                  .where(eq(paperTradesTable.id, trade.id))
                  .catch(e => console.warn(`[paperScanner] newSl update ${trade.symbol}:`, e.message));
                console.log(`[paperTrade] Version B trailing SL ${trade.symbol} ${trade.direction}: ${trade.stopLoss} → ${rv.newSl}`);
              } else {
                console.warn(`[paperTrade] newSl rejected ${trade.symbol} ${trade.direction}: proposed=${rv.newSl} current=${trade.stopLoss} (must ${isLong ? "be higher" : "be lower"})`);
              }
            }
          }
          // HOLD with no newSl: no action
        }

        console.log(`[paperScanner] Portfolio review: ${portfolioDecision.positionReviews.length} decisions, $${balanceFromClosures.toFixed(2)} freed | ${portfolioDecision.portfolioReasoning.slice(0, 150)}`);
      }
    }

    // ── Open new entries ───────────────────────────────────────────────────────
    let logged = 0;

    // Recalculate open count after CLOSE decisions (PARTIAL_CLOSE stays open)
    const closedByReview = new Set(
      portfolioDecision.positionReviews
        .filter(rv => rv.decision === "CLOSE")
        .map(rv => rv.symbol)
    );
    const stillOpenCount = openTrades.filter(t =>
      !closedByReview.has(t.symbol) && !closedByReview.has(t.symbol.replace(/USDT$/, ""))
    ).length;

    const effectivePaperBalance = paperBalance + balanceFromClosures;
    const marginInUse           = stillOpenCount * Math.max(5, effectivePaperBalance * 0.05);
    const availableBalance      = effectivePaperBalance - marginInUse;

    if (availableBalance < 5) {
      console.log(`[paperTrade] Insufficient paper balance ($${availableBalance.toFixed(2)} available after review) — skip new entries`);
      if (balanceFromClosures > 0) {
        await setPaperBalance(Math.max(0, effectivePaperBalance))
          .catch(e => console.warn("[paperScanner] balance update:", e.message));
      }
      console.log(`[paperScanner] Version B complete — 0 new entries, $${balanceFromClosures.toFixed(2)} freed from closures`);
      return;
    }
    let runningBalance = availableBalance;

    // Use portfolio review's chosen entries when available; fall back to scan signals
    const oppMap = new Map((res.data.opportunities as ScanOpportunity[]).map(o => [o.symbol, o]));
    const entriesToProcess: Array<{ symbol: string; direction: string; reasoning: string }> =
      portfolioDecision.newEntries.length > 0
        ? portfolioDecision.newEntries
        : (res.data.opportunities as ScanOpportunity[])
            .filter(o => o.direction && o.direction !== "neutral")
            .map(o => ({ symbol: o.symbol, direction: o.direction!, reasoning: o.whyNow ?? "" }));

    for (const entry of entriesToProcess) {
      if (runningBalance < 5) {
        console.log(`[paperTrade] Paper balance $${runningBalance.toFixed(2)} below $5 minimum — stopped`);
        break;
      }

      const opp = oppMap.get(entry.symbol) ?? oppMap.get(entry.symbol.replace(/USDT$/, "")) ?? oppMap.get(entry.symbol + "USDT");
      if (!opp || !opp.entry || opp.entry <= 0) {
        console.log(`[paperTrade] Skipping ${entry.symbol} — no entry price from scan`);
        continue;
      }

      // Fall back to scan direction if review entry omitted it
      const direction = entry.direction || opp.direction;
      if (!direction || direction === "neutral") {
        console.log(`[paperTrade] Skipping ${entry.symbol} — no valid direction`);
        continue;
      }

      // Deduplicate — skip if same symbol+direction already open
      const existing = await db.select({ id: paperTradesTable.id })
        .from(paperTradesTable)
        .where(and(
          eq(paperTradesTable.symbol, entry.symbol),
          eq(paperTradesTable.direction, direction),
          eq(paperTradesTable.status, "open"),
        )).limit(1).catch(() => [] as Array<{ id: number }>);
      if (existing.length > 0) {
        console.log(`[paperTrade] Skipping duplicate — ${entry.symbol} ${direction} already open`);
        continue;
      }

      // Claude's sizing, clamped to [$5, 50% of available balance]
      const claudeSize  = opp.positionSizeUsd ?? 0;
      const tradeMargin = Math.max(5, Math.min(claudeSize > 0 ? claudeSize : runningBalance * 0.05, runningBalance * 0.50));

      // Realistic fill: random slippage 0.05%–0.15%
      const slippagePct  = 0.0005 + Math.random() * 0.001;
      const rawEntry     = opp.entry ?? opp.price;
      const actualEntry  = direction === "long"
        ? rawEntry * (1 + slippagePct)
        : rawEntry * (1 - slippagePct);

      // Open fee: taker 0.055% on notional
      const leverage   = opp.leverage ?? 10;
      const notional   = tradeMargin * leverage;
      const openFee    = notional * 0.00055;
      const slipCost   = notional * slippagePct;

      runningBalance       -= tradeMargin;
      totalFeesThisScan    += openFee;
      totalSlippageThisScan += slipCost;

      await db.insert(paperTradesTable).values({
        symbol:     entry.symbol,
        direction:  direction,
        entryPrice: actualEntry,
        stopLoss:   opp.stopLoss         ?? null,
        tp1:        opp.tp1              ?? null,
        tp2:        opp.tp2              ?? null,
        rr:         opp.riskRewardRatio  ?? null,
        regime:     regime.regime,
        score:      opp.score            ?? null,
        whyNow:     entry.reasoning || opp.whyNow || null,
        setupType:  opp.setupType        ?? null,
        signalTime: new Date(),
        status:     "open",
        version:    "B",
        marginUsed: tradeMargin,
      }).catch(e => { console.warn(`[paperScanner] DB insert ${entry.symbol}:`, e.message); dbWriteAlert(`insert ${entry.symbol}`, e); });

      console.log(
        `[paperTrade] Version B would enter: ${entry.symbol} ${direction} ` +
        `at $${actualEntry.toFixed(4)} (slip=${(slippagePct * 100).toFixed(3)}%) margin=$${tradeMargin.toFixed(2)} balance=$${runningBalance.toFixed(2)} score=${opp.score}`
      );
      console.log(`[paperFee] ${entry.symbol} open fee: $${openFee.toFixed(4)}`);
      logged++;
    }

    // Single balance write: fees deducted on top of trade spend
    const newTradeSpend = availableBalance - runningBalance;
    const finalBalance  = Math.max(0, effectivePaperBalance - newTradeSpend - totalFeesThisScan);
    if (finalBalance !== paperBalance || totalFeesThisScan > 0 || totalSlippageThisScan > 0) {
      await db.update(botStateTable).set({
        paperBalance:       finalBalance,
        ...(totalFeesThisScan    > 0 ? { paperTotalFees:     sql`paper_total_fees + ${totalFeesThisScan}` }         : {}),
        ...(totalSlippageThisScan > 0 ? { paperTotalSlippage: sql`paper_total_slippage + ${totalSlippageThisScan}` } : {}),
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, 1))
        .catch(e => { console.warn("[paperScanner] balance update:", e.message); dbWriteAlert("balance update", e); });
    }

    console.log(`[paperScanner] Version B complete — ${logged} new entries, balance=$${finalBalance.toFixed(2)}, freed=$${balanceFromClosures.toFixed(2)} (${res.data.opportunities.length} scan signals)`);
  } catch (err) {
    console.error("[paperScanner] Scan failed:", err);
  }
}

// ── Mode 3 paper simulation (piggybacked on live scan signals, zero extra API cost) ──

export async function runMode3PaperScan(
  filteredSignals: ScanOpportunity[],
  regimeType:      string,
): Promise<void> {
  try {
    // Gate 1: hard regime block (CHOPPY / EXHAUSTION / VOLATILE never enter in Mode 3)
    if (["CHOPPY", "EXHAUSTION", "VOLATILE"].includes(regimeType)) {
      console.log(`[mode3Paper] Regime ${regimeType} hard-blocked — no entries`);
      return;
    }

    // Gate 2: regime score threshold
    const threshold  = getRegimeThreshold(regimeType);
    const qualifying = filteredSignals.filter(o =>
      o.direction && o.direction !== "neutral" &&
      o.stopLoss && o.tp1 && o.setupType && o.score != null &&
      o.score >= threshold
    );

    console.log(`[mode3Paper] Regime=${regimeType} threshold=${threshold} — ${qualifying.length}/${filteredSignals.length} signals qualify`);
    if (!qualifying.length) return;

    const balance = await getMode3PaperBalance();
    if (balance < 5) {
      console.log(`[mode3Paper] Balance $${balance.toFixed(2)} below $5 — stopped`);
      return;
    }

    let runningBalance = balance;
    let totalFees      = 0;
    let totalSlippage  = 0;
    let logged         = 0;

    for (const opp of qualifying) {
      if (runningBalance < 5) break;

      // Dedup — skip if same symbol+direction already open as mode3 paper
      const existing = await db.select({ id: paperTradesTable.id })
        .from(paperTradesTable)
        .where(and(
          eq(paperTradesTable.symbol,    opp.symbol),
          eq(paperTradesTable.direction, opp.direction!),
          eq(paperTradesTable.status,    "open"),
          eq(paperTradesTable.version,   "mode3"),
        )).limit(1).catch(() => [] as Array<{ id: number }>);
      if (existing.length > 0) {
        console.log(`[mode3Paper] Dedup — ${opp.symbol} ${opp.direction} already open`);
        continue;
      }

      const tradeMargin  = Math.max(5, Math.min(opp.positionSizeUsd ?? runningBalance * 0.05, runningBalance * 0.50));
      const slippagePct  = 0.0005 + Math.random() * 0.001;
      const rawEntry     = opp.entry ?? opp.price;
      const actualEntry  = opp.direction === "long"
        ? rawEntry * (1 + slippagePct)
        : rawEntry * (1 - slippagePct);
      const leverage     = opp.leverage ?? 10;
      const notional     = tradeMargin * leverage;
      const openFee      = notional * 0.00055;
      const slipCost     = notional * slippagePct;

      runningBalance -= tradeMargin;
      totalFees      += openFee;
      totalSlippage  += slipCost;

      await db.insert(paperTradesTable).values({
        symbol:     opp.symbol,
        direction:  opp.direction!,
        entryPrice: actualEntry,
        stopLoss:   opp.stopLoss        ?? null,
        tp1:        opp.tp1             ?? null,
        tp2:        opp.tp2             ?? null,
        rr:         opp.riskRewardRatio ?? null,
        regime:     regimeType,
        score:      opp.score           ?? null,
        whyNow:     opp.whyNow          ?? null,
        setupType:  opp.setupType       ?? null,
        signalTime: new Date(),
        status:     "open",
        version:    "mode3",
        marginUsed: tradeMargin,
      }).catch(e => console.warn(`[mode3Paper] DB insert ${opp.symbol}:`, e.message));

      console.log(`[mode3Paper] Enter ${opp.symbol} ${opp.direction} at $${actualEntry.toFixed(4)} (slip=${(slippagePct*100).toFixed(3)}%) margin=$${tradeMargin.toFixed(2)} score=${opp.score} ≥ ${threshold}`);
      logged++;
    }

    const spent       = balance - runningBalance;
    const finalBal    = Math.max(0, balance - spent - totalFees);
    await db.update(botStateTable).set({
      mode3PaperBalance: finalBal,
      lastUpdated:       new Date(),
    }).where(eq(botStateTable.id, 1))
      .catch(e => console.warn("[mode3Paper] balance update:", e.message));

    console.log(`[mode3Paper] Complete — ${logged} entries, balance=$${finalBal.toFixed(2)}`);
  } catch (err) {
    console.error("[mode3Paper] Scan failed:", err);
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

    // ── 8h funding simulation ─────────────────────────────────────────────────
    let vBFundingCost = 0;
    let m3FundingCost = 0;
    if (Date.now() - lastPaperFundingAt >= 8 * 3600_000) {
      lastPaperFundingAt = Date.now();
      for (const trade of open) {
        try {
          const sym = `${trade.symbol}USDT`.replace(/USDTUSDT$/, "USDT");
          const cur = priceMap.get(sym);
          if (!cur) continue;
          const fr = await getFundingRate(sym).catch(() => null);
          if (!fr) continue;
          const fundingCost = (trade.marginUsed ?? 5) * 10 * Math.abs(fr.rate);
          if (trade.version === "mode3") m3FundingCost += fundingCost;
          else                           vBFundingCost  += fundingCost;
          console.log(`[paperFunding] ${trade.symbol} (${trade.version ?? "B"}) rate=${(fr.rate * 100).toFixed(4)}% cost=$${fundingCost.toFixed(4)}`);
        } catch { /* skip */ }
      }
      const totalFunding = vBFundingCost + m3FundingCost;
      if (totalFunding > 0) console.log(`[paperFunding] Total this cycle: $${totalFunding.toFixed(4)} (vB=$${vBFundingCost.toFixed(4)} m3=$${m3FundingCost.toFixed(4)})`);
    }

    // Process all trades, accumulate balance returns split by version
    const now = new Date();
    let vBBalanceReturn = 0;
    let vBCloseFees     = 0;
    let m3BalanceReturn = 0;
    let m3CloseFees     = 0;

    for (const trade of open) {
      try {
        const sym     = `${trade.symbol}USDT`.replace(/USDTUSDT$/, "USDT");
        const current = priceMap.get(sym);
        if (!current) continue;

        const entry   = trade.entryPrice;
        const isLong  = trade.direction === "long";
        const pnlPct  = isLong ? (current - entry) / entry * 100 : (entry - current) / entry * 100;
        const isMode3 = trade.version === "mode3";

        console.log(`[paperMonitor] ${trade.symbol} ${trade.direction} (${trade.version ?? "B"}) entry=${entry} price=${current} tp1=${trade.tp1 ?? "—"} sl=${trade.stopLoss ?? "—"} pnl%=${pnlPct.toFixed(2)}`);

        let newStatus = "open";
        let exitPrice: number | null = null;

        if      (trade.stopLoss && (isLong ? current <= trade.stopLoss : current >= trade.stopLoss)) { newStatus = "stopped_out"; exitPrice = trade.stopLoss; }
        else if (trade.tp2      && (isLong ? current >= trade.tp2      : current <= trade.tp2))      { newStatus = "tp2_hit";    exitPrice = trade.tp2; }
        else if (trade.tp1      && (isLong ? current >= trade.tp1      : current <= trade.tp1))      { newStatus = "tp1_hit";    exitPrice = trade.tp1; }

        const finalPct     = exitPrice ? (isLong ? (exitPrice - entry) / entry : (entry - exitPrice) / entry) * 100 : pnlPct;
        const realizedPnl  = exitPrice ? (trade.marginUsed ?? 5) * 10 * (finalPct / 100) : null;

        const exitReason = newStatus === "stopped_out" ? "sl_hit"
          : newStatus === "tp2_hit" ? "tp2_hit"
          : newStatus === "tp1_hit" ? "tp1_hit"
          : undefined;
        await db.update(paperTradesTable).set({
          wouldHavePnl:    finalPct * (trade.marginUsed ?? 5) * 10 / 100,
          wouldHavePnlPct: finalPct,
          ...(newStatus !== "open" ? { status: newStatus, exitPrice, exitTime: now, exitReason } : {}),
        }).where(eq(paperTradesTable.id, trade.id));

        // Accumulate balance return and close fee for closed trades (split by version)
        if (newStatus !== "open" && trade.marginUsed) {
          const closeFee = trade.marginUsed * 10 * 0.00055;
          if (isMode3) {
            m3BalanceReturn += trade.marginUsed + (realizedPnl ?? 0);
            m3CloseFees     += closeFee;
          } else {
            vBBalanceReturn += trade.marginUsed + (realizedPnl ?? 0);
            vBCloseFees     += closeFee;
          }
          console.log(`[paperFee] ${trade.symbol} (${trade.version ?? "B"}) close fee: $${closeFee.toFixed(4)}`);
          generateReflection({
            symbol:        trade.symbol,
            direction:     trade.direction,
            entryPrice:    entry,
            exitPrice:     exitPrice ?? current,
            pnl:           realizedPnl ?? 0,
            pnlPct:        finalPct,
            entryAt:       trade.signalTime,
            exitAt:        now,
            setupType:     trade.setupType ?? null,
            score:         trade.score != null ? String(trade.score) : null,
            whyNow:        trade.whyNow ?? null,
            sl:            trade.stopLoss != null ? String(trade.stopLoss) : null,
            tp1:           trade.tp1 != null ? String(trade.tp1) : null,
            tp2:           trade.tp2 != null ? String(trade.tp2) : null,
            sourceTradeId: String(trade.id),
            suppressAlerts: true,
            source:        isMode3 ? "mode3" : "version_b",
          }).catch(e => console.error(`[paperReflection] ${newStatus} ${trade.symbol}:`, e.message));
        }
      } catch { /* skip individual trade errors */ }
    }

    // Version B balance update
    if (vBBalanceReturn !== 0 || vBCloseFees !== 0 || vBFundingCost !== 0) {
      const bal = await getPaperBalance();
      await db.update(botStateTable).set({
        paperBalance: Math.max(0, bal + vBBalanceReturn - vBCloseFees - vBFundingCost),
        ...(vBCloseFees   > 0 ? { paperTotalFees:    sql`paper_total_fees + ${vBCloseFees}` }       : {}),
        ...(vBFundingCost > 0 ? { paperTotalFunding: sql`paper_total_funding + ${vBFundingCost}` } : {}),
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, 1))
        .catch(e => { console.warn("[paperScanner] vB balance return:", e.message); dbWriteAlert("monitor vB balance return", e); });
    }

    // Mode 3 balance update
    if (m3BalanceReturn !== 0 || m3CloseFees !== 0 || m3FundingCost !== 0) {
      const m3bal = await getMode3PaperBalance();
      await db.update(botStateTable).set({
        mode3PaperBalance: Math.max(0, m3bal + m3BalanceReturn - m3CloseFees - m3FundingCost),
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, 1))
        .catch(e => { console.warn("[paperScanner] m3 balance return:", e.message); dbWriteAlert("monitor m3 balance return", e); });
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
  if (alertFn) _paperAlertFn = alertFn;  // store for DB write failure alerts
  // every 5 minutes — monitors both version B and mode3 paper trades
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
