import cron, { type ScheduledTask } from "node-cron";
import { runScan, type ScanResult }        from "./marketScanner";
import { cache, CacheKey }                 from "./contextCache";
import { approvalGate, buildProposal }     from "./approvalGate";
import { getLeverageForCoin, isCoinSuspended, updateDailyPnl, getSuspendedCoins } from "./leverageManager";
import { getDailyPnl }                     from "./tradeMemoryLib";
import { openPosition as bybitOpen, setTrailingStop } from "../brokers/bybit";
import { openPosition as okxOpen }         from "../brokers/okx";
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
const TRAILING_STOP    = 0.40; // 40% trailing stop on Bybit positions

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

// ── Auto-execute strong conviction signals ────────────────────────────────────
async function executeSignal(opp: ScanResult["opportunities"][0], totalCapital: number): Promise<void> {
  const sym   = opp.symbol;
  const isCrypto = opp.assetClass === "Crypto" || sym.includes("USDT");

  if (await isCoinSuspended(sym)) {
    console.log(`[cronScanner] ${sym} skipped — suspended`);
    return;
  }

  let leverage = 10;
  try { leverage = await getLeverageForCoin(sym); }
  catch (e) { console.warn(`[cronScanner] Leverage error for ${sym}:`, e); return; }

  const amount = Math.min(opp.positionSizeUsd ?? 50, totalCapital * 0.5, 50);
  const side   = opp.direction === "short" ? "Sell" : "Buy";

  try {
    if (isCrypto) {
      // Futures on Bybit for crypto
      const { orderId } = await bybitOpen(sym, side as "Buy" | "Sell", amount, leverage);
      // Set 40% trailing stop
      await setTrailingStop(sym, TRAILING_STOP);
      console.log(`[cronScanner] Auto-executed ${side} ${sym} $${amount} ${leverage}x → ${orderId}`);
      await alertFn?.(`🤖 Auto-trade: ${side} ${sym}\n$${amount} at ${leverage}x\nOrderId: ${orderId}\nStop: 40% trailing`).catch(() => {});
    } else {
      // Spot on OKX for non-crypto
      const { orderId } = await okxOpen(sym, side.toLowerCase() as "buy" | "sell", amount);
      console.log(`[cronScanner] Auto-executed ${side} ${sym} $${amount} spot → ${orderId}`);
      await alertFn?.(`🤖 Auto-trade (spot): ${side} ${sym} $${amount}\nOrderId: ${orderId}`).catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cronScanner] Auto-execute ${sym} failed:`, msg);
    await alertFn?.(`❌ Auto-trade failed: ${sym}\n${msg}`).catch(() => {});
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
          amountUsd:    Math.min(opp.positionSizeUsd ?? 50, totalCapital * 0.5),
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
