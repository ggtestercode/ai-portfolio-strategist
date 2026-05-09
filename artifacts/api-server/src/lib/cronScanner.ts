import cron, { type ScheduledTask }   from "node-cron";
import { runScan, type ScanResult }    from "./marketScanner";
import { cache, CacheKey }             from "./contextCache";
import { approvalGate, buildProposal } from "./approvalGate";
import { syncTotalCapitalToDB }        from "./brokerBalance";
import { isCoinSuspended, updateDailyPnl } from "./leverageManager";
import { getDailyPnl, logOpenTrade, closeOpenTrade } from "./tradeMemoryLib";
import { llm }                         from "./llmRouter";
import {
  getPositions as bybitGetPositions,
  closePosition as bybitClose,
  type BybitPosition,
} from "../brokers/bybit";
import { db, profileTable, botStateTable, tradeMemoryTable } from "@workspace/db";
import { eq, and, desc }               from "drizzle-orm";

// ── Runtime state ─────────────────────────────────────────────────────────────
export let cronEnabled   = true;
export let tradingPaused = false;
export let pausedReason  = "";
export let lastScanTime: Date | null = null;

let cronTask:   ScheduledTask | null = null;
let isScanning: boolean             = false;

type ScanNotifier  = (result: ScanResult, triggered: "cron" | "manual") => Promise<void>;
type AlertNotifier = (message: string) => Promise<void>;

let notifyFn: ScanNotifier  | null = null;
let alertFn:  AlertNotifier | null = null;

export function registerScanNotifier(fn: ScanNotifier): void  { notifyFn = fn; }
export function registerAlertNotifier(fn: AlertNotifier): void { alertFn  = fn; }

const SCAN_INTERVAL   = process.env["SCAN_INTERVAL"] ?? "*/30 * * * *";
const MAX_AUTO_TRADES = parseInt(process.env["MAX_TRADES_PER_SCAN"] ?? "3");
const MAX_TRADE_USD   = parseInt(process.env["MAX_AUTO_TRADE_USD"] ?? "5");
const LOSS_LIMIT_PCT  = 0.30;
const EQUITY_CLASSES  = new Set(["Equity", "US Equity", "equity", "Stock", "stock", "ETF", "etf"]);

function humanInterval(crontab: string): string {
  if (crontab === "disabled")      return "disabled (manual only)";
  if (crontab === "*/30 * * * *")  return "every 30 minutes";
  if (crontab === "*/15 * * * *")  return "every 15 minutes";
  if (crontab === "0 */4 * * *")   return "every 4 hours";
  if (crontab === "0 */1 * * *")   return "every hour";
  return crontab;
}

// ── Scaling decision types ─────────────────────────────────────────────────────
type ScalingAction = "NEW" | "ADD" | "HOLD" | "CUT";

interface SignalOutcome {
  symbol:   string;
  action:   ScalingAction;
  amount?:  number;
  reason?:  string;
  pnlPct?:  number;
}

// ── Daily loss limit ───────────────────────────────────────────────────────────
async function checkDailyLossLimit(): Promise<boolean> {
  try {
    const [profile] = await db.select({ totalCapital: profileTable.totalCapital }).from(profileTable).limit(1);
    const totalCapital = profile?.totalCapital ?? 10000;

    const dailyPnl = await getDailyPnl();
    await updateDailyPnl(dailyPnl).catch(() => {});

    if (dailyPnl <= -(totalCapital * LOSS_LIMIT_PCT)) {
      const pct = ((Math.abs(dailyPnl) / totalCapital) * 100).toFixed(1);
      const msg = [
        `🛑 Daily loss limit hit — trading paused`,
        `Loss today: $${Math.abs(dailyPnl).toFixed(2)} (${pct}% of capital)`,
        `Resume tomorrow or type /resume to override`,
      ].join("\n");
      tradingPaused = true;
      pausedReason  = msg;
      await db.update(botStateTable).set({ tradingPaused: true, pausedReason: msg, lastUpdated: new Date() })
        .where(eq(botStateTable.id, 1)).catch(() => {});
      await alertFn?.(msg).catch(() => {});
      console.warn("[cronScanner] Loss limit hit — trading paused");
      return false;
    }
    return true;
  } catch { return true; }
}

// ── Log scaling decision to trade_memory ──────────────────────────────────────
async function logScalingDecision(
  symbol:    string,
  action:    ScalingAction,
  reasoning: string,
  pnlPct?:   number,
): Promise<void> {
  await db.insert(tradeMemoryTable).values({
    symbol,
    reflection: reasoning,
    whatWorked: action,
    whatDidnt:  pnlPct != null ? `P/L at decision: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : null,
  }).catch(e => console.error("[cronScanner] logScalingDecision failed:", e));
}

// ── Check if this position was already scaled once ────────────────────────────
async function wasAlreadyScaled(symbol: string): Promise<boolean> {
  const row = await db.select({ whatWorked: tradeMemoryTable.whatWorked })
    .from(tradeMemoryTable)
    .where(and(eq(tradeMemoryTable.symbol, symbol), eq(tradeMemoryTable.whatWorked, "ADD")))
    .orderBy(desc(tradeMemoryTable.createdAt))
    .limit(1)
    .then(r => r[0]);
  return !!row;
}

// ── Combined scan + position review ──────────────────────────────────────────

interface SignalDecision {
  symbol:      string;
  action:      "NEW" | "SKIP";
  reason:      string;
  stopLoss?:   number;
  takeProfit?: number;
}

interface PositionDecision {
  symbol: string;
  action: "HOLD" | "ADD" | "CUT";
  reason: string;
}

interface CombinedReview {
  signals:   SignalDecision[];
  positions: PositionDecision[];
}

function bybitSym(sym: string): string {
  const s = sym.toUpperCase().replace(/[-/]/g, "").replace(/[^A-Z0-9]/g, "");
  return s.endsWith("USDT") || s.endsWith("USDC") ? s : `${s}USDT`;
}

async function makeCombinedReview(
  opps:          ScanResult["opportunities"],
  livePositions: BybitPosition[],
  totalCapital:  number,
): Promise<CombinedReview> {
  if (!opps.length && !livePositions.length) return { signals: [], positions: [] };

  const signalLines = opps.slice(0, 5).map((sig, i) => {
    const dir = sig.direction?.toUpperCase() ?? "LONG";
    const sl  = sig.stopLoss   ? ` SL=$${sig.stopLoss.toFixed(4)}`   : "";
    const tp  = sig.takeProfit ? ` TP=$${sig.takeProfit.toFixed(4)}`  : "";
    const rr  = sig.riskRewardRatio ? ` RR=${sig.riskRewardRatio.toFixed(1)}` : "";
    return `${i+1}. ${sig.symbol} ${dir} ${sig.recommendation} score=${sig.score}${sl}${tp}${rr} conviction=${sig.conviction ?? "?"} — ${(sig.reasoning ?? "").slice(0, 120)}`;
  }).join("\n");

  const positionLines = livePositions.length
    ? livePositions.map(p => {
        const pnlStr = `${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)} (${p.pnlPct.toFixed(2)}%)`;
        const slStr  = p.stopLoss  ? ` SL=$${p.stopLoss}`  : "";
        const tpStr  = p.takeProfit ? ` TP=$${p.takeProfit}` : "";
        return `- ${p.symbol} ${p.side} ${p.leverage}x entry=$${p.entryPrice.toFixed(4)} P/L=${pnlStr}${slStr}${tpStr}`;
      }).join("\n")
    : "None";

  const prompt = [
    `SCAN SIGNALS (${opps.length} crypto signals):`,
    signalLines || "None",
    ``,
    `EXISTING BYBIT POSITIONS (${livePositions.length}):`,
    positionLines,
    ``,
    `Capital: $${totalCapital} | Margin per trade: $${MAX_TRADE_USD} | 10x leverage → $${MAX_TRADE_USD * 10} notional`,
    `Max new entries this scan: ${MAX_AUTO_TRADES}`,
    ``,
    `RULES:`,
    `Signals: NEW only if conviction=strong_buy or strong_sell. Max ${MAX_AUTO_TRADES} NEW. SKIP all others.`,
    `Positions: ADD only if P/L > +3% and not already scaled. CUT if P/L < -8% or trend reversed. HOLD otherwise.`,
    `Include stopLoss and takeProfit absolute prices for each NEW signal.`,
  ].join("\n");

  const res = await llm.json<CombinedReview>({
    taskType:      "position_review",
    systemContext: "You are a disciplined quant managing a Bybit live account. Respond JSON only. Be decisive.",
    prompt,
    schema: {
      type: "object", required: ["signals", "positions"],
      properties: {
        signals:   {
          type: "array",
          items: {
            type: "object", required: ["symbol", "action", "reason"],
            properties: {
              symbol:     { type: "string" },
              action:     { type: "string", enum: ["NEW", "SKIP"] },
              reason:     { type: "string" },
              stopLoss:   { type: "number" },
              takeProfit: { type: "number" },
            },
          },
        },
        positions: {
          type: "array",
          items: {
            type: "object", required: ["symbol", "action", "reason"],
            properties: {
              symbol: { type: "string" },
              action: { type: "string", enum: ["HOLD", "ADD", "CUT"] },
              reason: { type: "string" },
            },
          },
        },
      },
    },
    fallback: { signals: [], positions: [] },
  });

  return res.data;
}

async function handlePositionDecision(
  decision:      PositionDecision,
  livePositions: BybitPosition[],
  outcomes:      SignalOutcome[],
): Promise<void> {
  const sym = decision.symbol;
  const pos = livePositions.find(p =>
    p.symbol === sym || p.symbol === bybitSym(sym) || bybitSym(p.symbol) === bybitSym(sym)
  );

  if (!pos) {
    console.log(`[cronScanner] ${sym} position not found for action ${decision.action}`);
    return;
  }

  if (decision.action === "HOLD") {
    await logScalingDecision(sym, "HOLD", decision.reason, pos.pnlPct);
    outcomes.push({ symbol: sym, action: "HOLD", reason: decision.reason, pnlPct: pos.pnlPct });
    return;
  }

  if (decision.action === "CUT") {
    try {
      await bybitClose(sym);
      const exitPrice = pos.entryPrice + (pos.pnl / Math.max(pos.size, 0.0001));
      await closeOpenTrade({ symbol: sym, broker: "bybit", exitPrice, amountUsd: pos.size * pos.entryPrice, entryPriceOverride: pos.entryPrice }).catch(() => {});
      await logScalingDecision(sym, "CUT", decision.reason, pos.pnlPct);
      outcomes.push({ symbol: sym, action: "CUT", reason: decision.reason, pnlPct: pos.pnlPct });
      const sign = pos.pnl >= 0 ? "+" : "";
      await alertFn?.(`✂️ Position CUT: ${sym}\nP/L: ${sign}$${pos.pnl.toFixed(2)} (${sign}${pos.pnlPct.toFixed(2)}%)\nReason: ${decision.reason}`).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cronScanner] CUT ${sym} failed:`, msg);
      outcomes.push({ symbol: sym, action: "HOLD", reason: `CUT failed: ${msg}` });
    }
    return;
  }

  if (decision.action === "ADD") {
    if (await wasAlreadyScaled(sym)) {
      outcomes.push({ symbol: sym, action: "HOLD", reason: "Already scaled once — no further ADD", pnlPct: pos.pnlPct });
      return;
    }
    const proposal = buildProposal({
      symbol:       sym,
      side:         pos.side === "Buy" ? "buy" : "sell",
      amountUsd:    MAX_TRADE_USD,
      assetClass:   "Crypto",
      broker:       "bybit",
      rationale:    `[Cron/Scale] ADD to winner: ${decision.reason}`,
      currentPrice: pos.entryPrice,
    });
    const gateResult = await approvalGate.submit(proposal).catch(e => ({
      action: "failed" as const, message: String(e), proposal, orderId: undefined,
    }));
    if (gateResult.action === "executed" || gateResult.action === "queued") {
      await logScalingDecision(sym, "ADD", decision.reason, pos.pnlPct);
    }
    outcomes.push({ symbol: sym, action: gateResult.action === "executed" ? "ADD" : "HOLD", reason: gateResult.message, pnlPct: pos.pnlPct });
  }
}

// ── Auto take-profit / stop-loss monitor ─────────────────────────────────────
// Bybit SL/TP set on orders and via trading-stop API — no separate auto-close loop needed.
async function checkAndAutoClose(): Promise<void> { return; }

// ── Format scan summary for Telegram ─────────────────────────────────────────
function formatScanSummary(outcomes: SignalOutcome[], total: number): string {
  const lines: string[] = [`🔍 Scan complete — ${total} signal${total !== 1 ? "s" : ""} found`];

  for (const o of outcomes) {
    const pnlTag = o.pnlPct != null ? ` (${o.pnlPct >= 0 ? "+" : ""}${o.pnlPct.toFixed(1)}%)` : "";
    switch (o.action) {
      case "NEW":
        lines.push(`✅ New entry: ${o.symbol} — $${o.amount ?? 50}`);
        break;
      case "ADD":
        lines.push(`📈 Adding to winner: ${o.symbol} — +$${o.amount ?? 50}${pnlTag}${o.reason ? `\n   (${o.reason})` : ""}`);
        break;
      case "HOLD":
        lines.push(`⏸️ Hold existing: ${o.symbol}${pnlTag}${o.reason ? `\n   (${o.reason})` : ""}`);
        break;
      case "CUT":
        lines.push(`✂️ Cut position: ${o.symbol}${pnlTag}${o.reason ? `\n   (${o.reason})` : ""}`);
        break;
    }
  }

  return lines.join("\n");
}

// ── Core scan logic ───────────────────────────────────────────────────────────
async function runCronScan(triggered: "cron" | "manual" = "cron"): Promise<void> {
  if (!cronEnabled && triggered === "cron") { console.log("[cronScanner] Skipped — disabled"); return; }
  if (tradingPaused)                         { console.log("[cronScanner] Skipped — trading paused"); return; }
  if (isScanning)                            { console.log("[cronScanner] Skipped — scan already in progress"); return; }

  const safe = await checkDailyLossLimit();
  if (!safe) return;

  isScanning = true;
  console.log(`[cronScanner] ${triggered === "manual" ? "Manual" : "Cron"} scan starting…`);
  lastScanTime = new Date();
  cache.invalidate(CacheKey.marketScan());

  try {
    // Sync live broker balances into DB before sizing trades
    const balances = await syncTotalCapitalToDB().catch(() => null);

    const result = await runScan();

    // Notify scan complete (sends to Telegram via registered notifier)
    await notifyFn?.(result, triggered).catch(e => console.error("[cronScanner] notify failed:", e));

    const [profile] = await db.select({ totalCapital: profileTable.totalCapital }).from(profileTable).limit(1)
      .catch(() => [null]);
    // Use live balance if available, fall back to DB value
    const totalCapital = (balances?.total ?? 0) > 0
      ? balances!.total
      : ((profile as { totalCapital?: number } | null)?.totalCapital ?? 200);

    const outcomes: SignalOutcome[] = [];

    // Crypto-only signals for Bybit (equities handled separately via eToro)
    const cryptoOpps = result.opportunities.filter(o => !EQUITY_CLASSES.has(o.assetClass ?? ""));

    // ── Combined scan + position review (single LLM call) ────────────────────
    const livePositions = await bybitGetPositions().catch(() => [] as BybitPosition[]);
    const review = await makeCombinedReview(cryptoOpps, livePositions, totalCapital);

    // Handle position actions (CUT is always immediate; ADD routes through gate)
    for (const posDecision of review.positions) {
      await handlePositionDecision(posDecision, livePositions, outcomes).catch(e =>
        console.error(`[cronScanner] posDecision ${posDecision.symbol}:`, e)
      );
    }

    // Handle new signal entries (approvalGate handles autonomous vs approval mode)
    const newSignals = review.signals.filter(s => s.action === "NEW").slice(0, MAX_AUTO_TRADES);
    for (const sig of newSignals) {
      if (await isCoinSuspended(sig.symbol)) continue;
      const matchedOpp = cryptoOpps.find(o => o.symbol === sig.symbol || bybitSym(o.symbol) === bybitSym(sig.symbol));
      if (!matchedOpp) continue;
      const proposal = buildProposal({
        symbol:          sig.symbol,
        side:            matchedOpp.direction === "short" ? "sell" : "buy",
        amountUsd:       Math.max(5, Math.min(matchedOpp.positionSizeUsd || MAX_TRADE_USD, totalCapital * 0.5, MAX_TRADE_USD)),
        assetClass:      matchedOpp.assetClass,
        broker:          "bybit",
        rationale:       `[Cron] ${matchedOpp.recommendation} score=${matchedOpp.score}. ${sig.reason}`,
        score:           matchedOpp.score,
        currentPrice:    matchedOpp.price,
        dataTimestamp:   matchedOpp.dataTimestamp,
        stopLossPrice:   sig.stopLoss,
        takeProfitPrice: sig.takeProfit,
      });
      const gateResult = await approvalGate.submit(proposal).catch(e => {
        console.error(`[cronScanner] submit ${sig.symbol}:`, e);
        return { action: "failed" as const, proposal, message: String(e), orderId: undefined };
      });
      outcomes.push({ symbol: sig.symbol, action: gateResult.action === "executed" ? "NEW" : "HOLD", reason: gateResult.message });
    }

    if (outcomes.length > 0) {
      const summary = formatScanSummary(outcomes, result.opportunities.length);
      await alertFn?.(summary).catch(() => {});
    } else {
      await alertFn?.(`🔍 Scan complete — ${result.opportunities.length} signal${result.opportunities.length !== 1 ? "s" : ""} found\n⏭️ No actions taken`).catch(() => {});
    }

    // Auto take-profit / stop-loss check after every scan
    await checkAndAutoClose().catch(e => console.error("[cronScanner] Auto-close check failed:", e));

    console.log(`[cronScanner] Complete — ${result.opportunities.length} signals`);
  } catch (err) {
    console.error("[cronScanner] Scan failed:", err);
  } finally {
    isScanning = false;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export function startCronScanner(): void {
  if (SCAN_INTERVAL === "disabled") {
    cronEnabled = false;
    console.log("[cronScanner] Auto-scan DISABLED — manual trigger only (/autoscan now)");
    return;
  }

  const interval = cron.validate(SCAN_INTERVAL) ? SCAN_INTERVAL : "*/30 * * * *";
  if (!cron.validate(SCAN_INTERVAL)) console.warn(`[cronScanner] Invalid SCAN_INTERVAL, using every 30 min`);

  cronTask = cron.schedule(interval, () => { void runCronScan("cron"); });
  setTimeout(() => { void runCronScan("cron"); }, 10_000);
  console.log(`[cronScanner] Started — schedule: ${humanInterval(interval)}`);
}

export function setCronEnabled(enabled: boolean): void {
  cronEnabled = enabled;
  if (enabled) cronTask?.start(); else cronTask?.stop();
  console.log(`[cronScanner] ${enabled ? "Enabled" : "Disabled"}`);
}

export function resumeTrading(): void {
  tradingPaused = false;
  pausedReason  = "";
  db.update(botStateTable).set({ tradingPaused: false, pausedReason: null, lastUpdated: new Date() })
    .where(eq(botStateTable.id, 1)).catch(() => {});
  console.log("[cronScanner] Trading resumed");
}

export async function triggerNow(): Promise<void> { return runCronScan("manual"); }

export function getStatus() {
  return {
    enabled:      cronEnabled,
    paused:       tradingPaused,
    pausedReason,
    lastScan:     lastScanTime,
    interval:     SCAN_INTERVAL,
    schedule:     humanInterval(SCAN_INTERVAL),
  };
}
