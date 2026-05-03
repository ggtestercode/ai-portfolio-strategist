import cron from "node-cron";
import { runScan, type ScanResult } from "./marketScanner";
import { cache, CacheKey }          from "./contextCache";
import { getPositions }             from "../brokers/okx";
import { db, profileTable }         from "@workspace/db";

// ── Runtime state ─────────────────────────────────────────────────────────────
export let cronEnabled   = true;
export let tradingPaused = false;
export let pausedReason  = "";
export let lastScanTime: Date | null = null;

let cronTask: cron.ScheduledTask | null = null;

type ScanNotifier  = (result: ScanResult, triggered: "cron" | "manual") => Promise<void>;
type AlertNotifier = (message: string) => Promise<void>;

let notifyFn: ScanNotifier  | null = null;
let alertFn:  AlertNotifier | null = null;

export function registerScanNotifier(fn: ScanNotifier): void  { notifyFn = fn; }
export function registerAlertNotifier(fn: AlertNotifier): void { alertFn  = fn; }

// ── Config ────────────────────────────────────────────────────────────────────
const SCAN_INTERVAL  = process.env["SCAN_INTERVAL"]      ?? "0 */4 * * *";
const LOSS_LIMIT_PCT = 0.30;

// ── Daily loss limit ──────────────────────────────────────────────────────────
async function checkDailyLossLimit(): Promise<boolean> {
  try {
    const [profile] = await db
      .select({ totalCapital: profileTable.totalCapital })
      .from(profileTable)
      .limit(1);
    const totalCapital = profile?.totalCapital ?? 10000;
    const lossLimit    = -(totalCapital * LOSS_LIMIT_PCT);

    const positions = await getPositions().catch(() => []);
    const totalPnl  = positions.reduce((sum, p) => sum + p.pnl, 0);

    if (totalPnl <= lossLimit) {
      const pct = ((Math.abs(totalPnl) / totalCapital) * 100).toFixed(1);
      const msg = [
        `🛑 Daily loss limit hit — trading paused`,
        `Loss today: $${Math.abs(totalPnl).toFixed(2)} (${pct}% of capital)`,
        `Resume tomorrow or type /resume to override`,
      ].join("\n");
      tradingPaused = true;
      pausedReason  = msg;
      await alertFn?.(msg).catch(() => {});
      console.warn("[cronScanner] Loss limit hit — trading paused");
      return false;
    }
    return true;
  } catch {
    return true; // don't block on error
  }
}

// ── Core scan logic ───────────────────────────────────────────────────────────
async function runCronScan(triggered: "cron" | "manual" = "cron"): Promise<void> {
  if (!cronEnabled && triggered === "cron") {
    console.log("[cronScanner] Skipped — disabled");
    return;
  }
  if (tradingPaused) {
    console.log("[cronScanner] Skipped — trading paused (loss limit)");
    return;
  }

  const safe = await checkDailyLossLimit();
  if (!safe) return;

  console.log(`[cronScanner] ${triggered === "manual" ? "Manual" : "Cron"} scan starting…`);
  lastScanTime = new Date();

  // Force fresh data (bypass 15-min cache)
  cache.invalidate(CacheKey.marketScan());

  try {
    const result = await runScan();
    await notifyFn?.(result, triggered).catch(e =>
      console.error("[cronScanner] notify failed:", e)
    );
    console.log(`[cronScanner] Complete — ${result.opportunities.length} signals`);
  } catch (err) {
    console.error("[cronScanner] Scan failed:", err);
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export function startCronScanner(): void {
  const interval = cron.validate(SCAN_INTERVAL) ? SCAN_INTERVAL : "0 */4 * * *";
  if (!cron.validate(SCAN_INTERVAL)) {
    console.warn(`[cronScanner] Invalid SCAN_INTERVAL "${SCAN_INTERVAL}", using every 4h`);
  }

  cronTask = cron.schedule(interval, () => { void runCronScan("cron"); });

  // First scan 10s after start so server + telegram are fully up
  setTimeout(() => { void runCronScan("cron"); }, 10_000);

  console.log(`[cronScanner] Started — interval: ${interval}`);
}

export function setCronEnabled(enabled: boolean): void {
  cronEnabled = enabled;
  if (enabled) cronTask?.start();
  else          cronTask?.stop();
  console.log(`[cronScanner] ${enabled ? "Enabled" : "Disabled"}`);
}

export function resumeTrading(): void {
  tradingPaused = false;
  pausedReason  = "";
  console.log("[cronScanner] Trading resumed");
}

export async function triggerNow(): Promise<void> {
  return runCronScan("manual");
}

export function getStatus(): {
  enabled:      boolean;
  paused:       boolean;
  pausedReason: string;
  lastScan:     Date | null;
  interval:     string;
} {
  return {
    enabled:      cronEnabled,
    paused:       tradingPaused,
    pausedReason,
    lastScan:     lastScanTime,
    interval:     SCAN_INTERVAL,
  };
}
