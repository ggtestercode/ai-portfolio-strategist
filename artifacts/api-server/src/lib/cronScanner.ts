import cron, { type ScheduledTask }   from "node-cron";
import { runScan, type ScanResult }    from "./marketScanner";
import { cache, CacheKey }             from "./contextCache";
import { approvalGate, buildProposal } from "./approvalGate";
import { syncTotalCapitalToDB }        from "./brokerBalance";
import { isCoinSuspended, updateDailyPnl } from "./leverageManager";
import { getDailyPnl, logOpenTrade, closeOpenTrade } from "./tradeMemoryLib";
import { llm }                         from "./llmRouter";
import {
  openPosition    as okxOpen,
  openLimitPosition as okxOpenLimit,
  closePosition   as okxClose,
  getPositions    as okxGetPositions,
  type OKXPosition,
} from "../brokers/okx";
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

// ── Convert Bybit-style symbol to OKX spot ────────────────────────────────────
function toOkxSpot(sym: string): string {
  if (sym.includes("-")) return sym;
  const quote = sym.endsWith("USDC") ? "USDC" : "USDT";
  const base  = sym.replace(/USDT$/, "").replace(/USDC$/, "");
  return `${base}-${quote}`;
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

// ── Ask Claude whether to ADD / HOLD / CUT ───────────────────────────────────
async function makeScalingDecision(
  opp:          ScanResult["opportunities"][0],
  pos:          OKXPosition,
  totalCapital: number,
): Promise<{ action: "ADD" | "HOLD" | "CUT"; reasoning: string }> {
  const posValue     = pos.entryPrice * pos.size;
  const exposurePct  = totalCapital > 0 ? (posValue / totalCapital) * 100 : 0;
  const newExposure  = totalCapital > 0 ? ((posValue + 50) / totalCapital) * 100 : 0;

  let prompt: string;

  if (pos.pnl > 0) {
    // ── Winning position ──
    if (await wasAlreadyScaled(opp.symbol)) {
      return { action: "HOLD", reasoning: "Already added to this position once — no further scaling." };
    }
    prompt = [
      `You already hold ${opp.symbol}.`,
      `Entry price: $${pos.entryPrice.toFixed(4)}`,
      `Current P/L: +${pos.pnlPct.toFixed(2)}%`,
      `Position size: ~$${posValue.toFixed(2)} (${exposurePct.toFixed(1)}% of capital)`,
      `New signal conviction: ${opp.conviction}`,
      `Price vs entry: +${pos.pnlPct.toFixed(2)}% above entry`,
      `If you ADD ~$50 more, total exposure would be ${newExposure.toFixed(1)}% of capital.`,
      ``,
      `Should you ADD to this position?`,
      `Rules:`,
      `- Only ADD if conviction is strong_buy`,
      `- Only ADD if total exposure after adding stays under 40% of capital`,
      ``,
      `Respond with JSON: { "action": "ADD" or "HOLD", "reasoning": "one sentence" }`,
    ].join("\n");
  } else {
    // ── Losing position ──
    const lossPct = Math.abs(pos.pnlPct);
    prompt = [
      `You hold ${opp.symbol} at a loss.`,
      `Entry price: $${pos.entryPrice.toFixed(4)}`,
      `Current P/L: -${lossPct.toFixed(2)}%`,
      `Position size: ~$${posValue.toFixed(2)}`,
      `New signal conviction: ${opp.conviction}`,
      ``,
      `Market context from scanner:`,
      opp.reasoning ?? "No additional context.",
      ``,
      `Decide:`,
      `ADD  — looks like stop hunt or wick; higher timeframe trend intact; loss within 5% of entry`,
      `HOLD — signal mixed, wait for clarity`,
      `CUT  — structure broken, trend reversed, close the position now`,
      ``,
      `Hard rules you cannot override:`,
      `- Never ADD if loss exceeds 8% from entry`,
      `- Never ADD more than once to a losing position`,
      ``,
      `Respond with JSON: { "action": "ADD" or "HOLD" or "CUT", "reasoning": "two sentences max" }`,
    ].join("\n");
  }

  const res = await llm.json<{ action: "ADD" | "HOLD" | "CUT"; reasoning: string }>({
    taskType:      "assistant_reply",
    systemContext: "You are a disciplined trading risk manager. Respond in JSON only. Be concise and specific.",
    prompt,
    schema: {
      type: "object", required: ["action", "reasoning"],
      properties: {
        action:    { type: "string", enum: ["ADD", "HOLD", "CUT"] },
        reasoning: { type: "string" },
      },
    },
    fallback: { action: "HOLD", reasoning: "Could not determine scaling decision." },
  });

  return { action: res.data.action, reasoning: res.data.reasoning };
}

// ── Execute a single signal with position-scaling logic ───────────────────────
async function evaluateAndExecuteSignal(
  opp:          ScanResult["opportunities"][0],
  totalCapital: number,
  livePositions: OKXPosition[],
): Promise<SignalOutcome> {
  const rawSym = opp.symbol;

  // Skip non-crypto (equities only trade on eToro)
  const assetClass = opp.assetClass ?? "Crypto";
  if (assetClass === "Equity" || assetClass === "Stock" || assetClass === "ETF") {
    console.log(`[cronScanner] ${rawSym} skipped — ${assetClass} not supported on OKX`);
    return { symbol: rawSym, action: "HOLD", reason: `${assetClass} not tradeable on OKX` };
  }

  if (await isCoinSuspended(rawSym)) {
    console.log(`[cronScanner] ${rawSym} skipped — suspended`);
    return { symbol: rawSym, action: "HOLD", reason: "coin suspended" };
  }

  const okxSym    = toOkxSpot(rawSym);
  const amount    = Math.max(10, Math.min(opp.positionSizeUsd || 50, totalCapital * 0.50, 50));
  const side      = opp.direction === "short" ? "sell" : "buy";
  const orderType = opp.orderType ?? "market";
  const limitPrice = opp.limitPrice ?? null;
  const okxMode   = process.env["OKX_TRADING_MODE"] === "demo" ? "Demo" : "Live";

  if (amount < 5) {
    return { symbol: okxSym, action: "HOLD", reason: `amount $${amount.toFixed(2)} below $5 minimum` };
  }

  // Check for existing open position
  const existingPos = livePositions.find(p =>
    p.symbol === okxSym || p.symbol.split("-")[0] === okxSym.split("-")[0]
  );

  if (existingPos) {
    // ── Position exists — ask Claude ──────────────────────────────────────────
    console.log(`[cronScanner] ${okxSym} — existing position (P/L ${existingPos.pnlPct.toFixed(2)}%), asking Claude…`);
    const { action, reasoning } = await makeScalingDecision(opp, existingPos, totalCapital);

    await logScalingDecision(okxSym, action, reasoning, existingPos.pnlPct);
    console.log(`[cronScanner] ${okxSym} scaling decision: ${action} — ${reasoning}`);

    if (action === "HOLD") {
      return { symbol: okxSym, action: "HOLD", reason: reasoning, pnlPct: existingPos.pnlPct };
    }

    if (action === "CUT") {
      try {
        await okxClose(okxSym);
        const exitPrice = opp.price ?? existingPos.entryPrice;
        await closeOpenTrade({
          symbol:             okxSym,
          broker:             "okx",
          exitPrice,
          amountUsd:          existingPos.size * existingPos.entryPrice,
          entryPriceOverride: existingPos.entryPrice,
        }).catch(() => {});
        console.log(`[cronScanner] CUT ${okxSym} — ${reasoning}`);
        return { symbol: okxSym, action: "CUT", reason: reasoning, pnlPct: existingPos.pnlPct };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[cronScanner] CUT ${okxSym} failed:`, msg);
        return { symbol: okxSym, action: "HOLD", reason: `CUT failed: ${msg}` };
      }
    }

    // action === "ADD" — fall through to execution below
  }

  // ── New entry or ADD ─────────────────────────────────────────────────────────
  const actionLabel: ScalingAction = existingPos ? "ADD" : "NEW";
  try {
    let orderId:    string;
    let entryPrice: number;

    if (orderType === "limit" && limitPrice) {
      const r = await okxOpenLimit(okxSym, side as "buy" | "sell", amount, limitPrice);
      orderId    = r.orderId;
      entryPrice = limitPrice;
    } else {
      const r = await okxOpen(okxSym, side as "buy" | "sell", amount);
      orderId    = r.orderId;
      entryPrice = r.entryPrice;
    }

    await logOpenTrade({
      symbol:    okxSym,
      broker:    "okx",
      direction: side === "sell" ? "short" : "long",
      entryPrice,
      leverage:  1,
      amountUsd: amount,
      reasoning: opp.reasoning,
    }).catch(e => console.error(`[cronScanner] Trade log insert failed:`, e));

    if (existingPos) {
      await logScalingDecision(okxSym, "ADD", `Added $${amount} to existing position`, existingPos.pnlPct);
    }

    const orderLabel = orderType === "limit" ? `Limit @$${limitPrice}` : "Market";
    console.log(`[cronScanner] ${actionLabel} ${side} ${okxSym} $${amount} (${orderLabel}) → ${orderId}`);
    return {
      symbol:  okxSym,
      action:  actionLabel,
      amount,
      pnlPct:  existingPos?.pnlPct,
      reason:  existingPos ? `added to winner (+${existingPos.pnlPct.toFixed(1)}%)` : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cronScanner] ${actionLabel} ${okxSym} failed:`, msg);
    return { symbol: okxSym, action: "HOLD", reason: `execution failed: ${msg}` };
  }
}

// ── Auto take-profit / stop-loss monitor ─────────────────────────────────────
const STOP_LOSS_PCT = 40; // close if down 40%

async function checkAndAutoClose(): Promise<void> {
  // OKX auto-close skipped — Bybit-only mode. Bybit positions managed manually.
  return;
  try {
    const [{ totalCapital }] = await db.select({ totalCapital: profileTable.totalCapital }).from(profileTable).limit(1).catch(() => [{ totalCapital: 0 }]);
    const [profile] = await db.select().from(profileTable).limit(1).catch(() => [null]);
    const takeProfitPct = profile?.targetReturnPct ?? 20;

    const positions = await okxGetPositions().catch(() => [] as OKXPosition[]);
    if (!positions.length) return;

    for (const pos of positions) {
      const pnlPct = pos.pnlPct;
      const shouldClose =
        pnlPct >= takeProfitPct ||
        pnlPct <= -STOP_LOSS_PCT;

      if (!shouldClose) continue;

      const reason = pnlPct >= takeProfitPct
        ? `take-profit hit (+${pnlPct.toFixed(1)}% ≥ ${takeProfitPct}%)`
        : `stop-loss hit (${pnlPct.toFixed(1)}% ≤ -${STOP_LOSS_PCT}%)`;

      console.log(`[autoClose] Closing ${pos.symbol}: ${reason}`);

      try {
        const result = await okxClose(pos.symbol);
        await closeOpenTrade(pos.symbol, pos.entryPrice, pos.pnl).catch(() => {});
        const sign = pnlPct >= 0 ? "+" : "";
        const msg  = [
          pnlPct >= takeProfitPct ? `✅ Take-profit triggered` : `🛑 Stop-loss triggered`,
          `${pos.symbol} closed · P/L ${sign}$${pos.pnl.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)`,
          `Order: ${result.orderId}`,
        ].join("\n");
        await alertFn?.(msg).catch(() => {});
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[autoClose] Failed to close ${pos.symbol}:`, m);
        await alertFn?.(`⚠️ Auto-close failed for ${pos.symbol}: ${m}`).catch(() => {});
      }
    }
  } catch (err) {
    console.error("[autoClose] Monitor error:", err);
  }
}

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

    const config = await approvalGate.getConfig();
    const outcomes: SignalOutcome[] = [];

    // Crypto-only signals for Bybit (equities handled separately via eToro)
    const cryptoOpps = result.opportunities.filter(o => !EQUITY_CLASSES.has(o.assetClass ?? ""));

    if (config.mode === "autonomous") {
      const strong = cryptoOpps
        .filter(o => o.conviction === "strong_buy" || o.conviction === "strong_sell")
        .slice(0, MAX_AUTO_TRADES);

      for (const sig of strong) {
        if (await isCoinSuspended(sig.symbol)) continue;
        const proposal = buildProposal({
          symbol:       sig.symbol,
          side:         sig.direction === "short" ? "sell" : "buy",
          amountUsd:    Math.max(5, Math.min(sig.positionSizeUsd || MAX_TRADE_USD, totalCapital * 0.5, MAX_TRADE_USD)),
          assetClass:   sig.assetClass,
          broker:       "bybit",
          rationale:    `[Cron/Auto] ${sig.recommendation} score=${sig.score}. ${sig.reasoning}`,
          score:        sig.score,
          currentPrice: sig.price,
          dataTimestamp: sig.dataTimestamp,
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
        await alertFn?.(`🔍 Scan complete — ${result.opportunities.length} signal${result.opportunities.length !== 1 ? "s" : ""} found\n⏭️ No strong conviction crypto signals to act on`).catch(() => {});
      }
    } else {
      // Approval mode: queue high-conviction crypto signals → Bybit
      const actionable = cryptoOpps.filter(o =>
        o.conviction === "high" || o.conviction === "strong_buy" || o.conviction === "strong_sell"
      ).slice(0, MAX_AUTO_TRADES);

      for (const opp of actionable) {
        if (await isCoinSuspended(opp.symbol)) continue;
        const proposal = buildProposal({
          symbol:       opp.symbol,
          side:         opp.direction === "short" ? "sell" : "buy",
          amountUsd:    Math.max(5, Math.min(opp.positionSizeUsd || MAX_TRADE_USD, totalCapital * 0.5, MAX_TRADE_USD)),
          assetClass:   opp.assetClass,
          broker:       "bybit",
          rationale:    `[Cron] ${opp.recommendation} score=${opp.score}. ${opp.reasoning}`,
          score:        opp.score,
          currentPrice: opp.price,
          dataTimestamp: opp.dataTimestamp,
        });
        approvalGate.submit(proposal).catch(e => console.error(`[cronScanner] submit ${opp.symbol}:`, e));
      }
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
