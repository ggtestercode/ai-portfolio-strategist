import cron, { type ScheduledTask } from "node-cron";
import { runScan, type ScanResult }        from "./marketScanner";
import { cache, CacheKey }                 from "./contextCache";
import { approvalGate, buildProposal }     from "./approvalGate";
import { isCoinSuspended, updateDailyPnl } from "./leverageManager";
import { getDailyPnl, logOpenTrade }       from "./tradeMemoryLib";
import { openPosition as okxOpen, openLimitPosition as okxOpenLimit } from "../brokers/okx";
import { db, profileTable, botStateTable } from "@workspace/db";
import { eq }                              from "drizzle-orm";

// ── Runtime state ─────────────────────────────────────────────────────────────
export let cronEnabled   = true;
export let tradingPaused = false;
export let pausedReason  = "";
export let lastScanTime: Date | null = null;

let cronTask: ScheduledTask | null = null;

type ScanNotifier  = (result: ScanResult, triggered: "cron" | "manual") => Promise<void>;
type AlertNotifier = (message: string) => Promise<void>;

let notifyFn: ScanNotifier  | null = null;
let alertFn:  AlertNotifier | null = null;

export function registerScanNotifier(fn: ScanNotifier): void  { notifyFn = fn; }
export function registerAlertNotifier(fn: AlertNotifier): void { alertFn  = fn; }

const SCAN_INTERVAL    = process.env["SCAN_INTERVAL"] ?? "0 */4 * * *";
const MAX_AUTO_TRADES  = parseInt(process.env["MAX_TRADES_PER_SCAN"] ?? "3");
const LOSS_LIMIT_PCT   = 0.30;

// ── Daily loss limit (uses trade_log) ────────────────────────────────────────
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

      // Persist to DB
      await db.update(botStateTable).set({ tradingPaused: true, pausedReason: msg, lastUpdated: new Date() })
        .where(eq(botStateTable.id, 1)).catch(() => {});

      await alertFn?.(msg).catch(() => {});
      console.warn("[cronScanner] Loss limit hit — trading paused");
      return false;
    }
    return true;
  } catch { return true; }
}

// ── Convert Bybit-style symbol to OKX spot (BTCUSDT → BTC-USDT) ─────────────
function toOkxSpot(sym: string): string {
  if (sym.includes("-")) return sym; // already OKX format
  const quote = sym.endsWith("USDC") ? "USDC" : "USDT";
  const base  = sym.replace(/USDT$/, "").replace(/USDC$/, "");
  return `${base}-${quote}`;
}

// ── Auto-execute strong conviction signals — OKX spot only ───────────────────
async function executeSignal(opp: ScanResult["opportunities"][0], totalCapital: number): Promise<void> {
  const rawSym = opp.symbol;

  // Stocks/equities can only trade on eToro — skip for OKX auto-execution
  const assetClass = opp.assetClass ?? "Crypto";
  if (assetClass === "Equity" || assetClass === "Stock" || assetClass === "ETF") {
    console.log(`[cronScanner] ${rawSym} skipped — ${assetClass} not supported on OKX`);
    return;
  }

  if (await isCoinSuspended(rawSym)) {
    console.log(`[cronScanner] ${rawSym} skipped — suspended`);
    return;
  }

  const maxPerTrade = totalCapital * 0.50;
  const amount      = Math.max(10, Math.min(opp.positionSizeUsd || 50, maxPerTrade, 50));
  const side        = opp.direction === "short" ? "sell" : "buy";
  const okxSym      = toOkxSpot(rawSym);
  const orderType   = opp.orderType ?? "market";
  const limitPrice  = opp.limitPrice ?? null;
  const okxMode     = process.env["OKX_TRADING_MODE"] === "demo" ? "Demo" : "Live";

  console.log(`[cronScanner] Auto-trade sizing: ${okxSym} totalCapital=$${totalCapital} amount=$${amount} orderType=${orderType}`);

  if (amount < 5) {
    console.warn(`[cronScanner] Skipping ${okxSym} — amount $${amount} below $5 minimum`);
    await alertFn?.(`⚠️ Skipping ${okxSym} — amount $${amount.toFixed(2)} below $5 minimum`).catch(() => {});
    return;
  }

  try {
    let orderId: string;
    let entryPrice: number;

    if (orderType === "limit" && limitPrice) {
      const r = await okxOpenLimit(okxSym, side as "buy" | "sell", amount, limitPrice);
      orderId    = r.orderId;
      entryPrice = limitPrice;
    } else {
      const r = await okxOpen(okxSym, side as "buy" | "sell", amount);
      orderId    = r.orderId;
      entryPrice = r.entryPrice;  // real OKX ticker price at execution time
    }

    // Log open trade for /history and reflection
    await logOpenTrade({
      symbol:    okxSym,
      broker:    "okx",
      direction: side === "sell" ? "short" : "long",
      entryPrice,
      leverage:  1,
      amountUsd: amount,
      reasoning: opp.reasoning,
    }).catch(e => console.error(`[cronScanner] Trade log insert failed:`, e));

    const orderLabel = orderType === "limit" ? `Limit @$${limitPrice}` : "Market";
    console.log(`[cronScanner] Auto-executed ${side} ${okxSym} $${amount} spot (${orderLabel}) → ${orderId}`);
    await alertFn?.([
      `🤖 Auto-trade: ${side.toUpperCase()} ${okxSym} — Executed`,
      `Order ID: ${orderId}`,
      `Amount: $${amount} (spot)`,
      `Order: ${orderLabel}`,
      `Broker: OKX ${okxMode}`,
      `Time: ${new Date().toUTCString()}`,
    ].join("\n")).catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cronScanner] Auto-execute ${okxSym} failed:`, msg);
    await alertFn?.(`❌ Auto-trade failed: ${okxSym}\n${msg}`).catch(() => {});
  }
}

// ── Core scan logic ───────────────────────────────────────────────────────────
async function runCronScan(triggered: "cron" | "manual" = "cron"): Promise<void> {
  if (!cronEnabled && triggered === "cron") { console.log("[cronScanner] Skipped — disabled"); return; }
  if (tradingPaused)                         { console.log("[cronScanner] Skipped — trading paused"); return; }

  const safe = await checkDailyLossLimit();
  if (!safe) return;

  console.log(`[cronScanner] ${triggered === "manual" ? "Manual" : "Cron"} scan starting…`);
  lastScanTime = new Date();
  cache.invalidate(CacheKey.marketScan());

  try {
    const result = await runScan();

    // Notify scan complete
    await notifyFn?.(result, triggered).catch(e => console.error("[cronScanner] notify failed:", e));

    // Auto-execute strong conviction signals (bypass approval gate)
    const [profile] = await db.select({ totalCapital: profileTable.totalCapital }).from(profileTable).limit(1)
      .catch(() => [null]);
    const totalCapital = (profile as { totalCapital?: number } | null)?.totalCapital ?? 200;

    const config = await approvalGate.getConfig();
    if (config.mode === "autonomous") {
      const strong = result.opportunities
        .filter(o => o.conviction === "strong_buy" || o.conviction === "strong_sell")
        .slice(0, MAX_AUTO_TRADES);

      for (const sig of strong) {
        await executeSignal(sig, totalCapital);
      }
    } else {
      // Approval mode: submit high-conviction signals for approval
      const actionable = result.opportunities.filter(o =>
        o.conviction === "high" || o.conviction === "strong_buy" || o.conviction === "strong_sell"
      ).slice(0, MAX_AUTO_TRADES);

      for (const opp of actionable) {
        if (await isCoinSuspended(opp.symbol)) continue;
        const proposal = buildProposal({
          symbol:       opp.symbol,
          side:         opp.direction === "short" ? "sell" : "buy",
          amountUsd:    Math.max(10, Math.min(opp.positionSizeUsd || 50, totalCapital * 0.5, 50)),
          assetClass:   opp.assetClass,
          rationale:    `[Cron] ${opp.recommendation} score=${opp.score}. ${opp.reasoning}`,
          score:        opp.score,
          currentPrice: opp.price,
          dataTimestamp: opp.dataTimestamp,
        });
        approvalGate.submit(proposal).catch(e => console.error(`[cronScanner] submit ${opp.symbol}:`, e));
      }
    }

    console.log(`[cronScanner] Complete — ${result.opportunities.length} signals`);
  } catch (err) {
    console.error("[cronScanner] Scan failed:", err);
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export function startCronScanner(): void {
  const interval = cron.validate(SCAN_INTERVAL) ? SCAN_INTERVAL : "0 */4 * * *";
  if (!cron.validate(SCAN_INTERVAL)) console.warn(`[cronScanner] Invalid SCAN_INTERVAL, using every 4h`);

  cronTask = cron.schedule(interval, () => { void runCronScan("cron"); });
  setTimeout(() => { void runCronScan("cron"); }, 10_000);
  console.log(`[cronScanner] Started — interval: ${interval}`);
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
  return { enabled: cronEnabled, paused: tradingPaused, pausedReason, lastScan: lastScanTime, interval: SCAN_INTERVAL };
}
