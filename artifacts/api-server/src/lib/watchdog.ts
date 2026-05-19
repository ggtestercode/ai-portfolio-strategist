import { db }              from "@workspace/db";
import { sql }             from "drizzle-orm";
import { getBalance }      from "../brokers/bybit";
import { checkBotHealth }  from "../notifications/telegram";

const INTERVAL_MS      = 5 * 60 * 1000;
const WATCHDOG_ENABLED = process.env["WATCHDOG_ENABLED"] !== "false";

let alertFn: ((msg: string) => Promise<void>) | null = null;
export function registerWatchdogAlert(fn: (msg: string) => Promise<void>): void { alertFn = fn; }

const NEON_COMPUTE_PATTERNS = ["compute", "read-only", "readonly", "quota", "suspend", "limit reached", "too many connections"];
let _neonAlertSent = false; // deduplicate — alert once until resolved

async function check(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    if (name === "Database") _neonAlertSent = false; // reset on successful DB ping
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[watchdog] ❌ ${name}: ${msg}`);

    const isNeonCompute = name === "Database" &&
      NEON_COMPUTE_PATTERNS.some(p => msg.toLowerCase().includes(p));

    if (isNeonCompute && !_neonAlertSent) {
      _neonAlertSent = true;
      await alertFn?.([
        `⚠️ <b>Neon compute limit approaching</b>`,
        `DB may go read-only soon`,
        `Error: ${msg.slice(0, 150)}`,
        `Action needed: upgrade plan or wait for reset`,
      ].join("\n")).catch(() => {});
    } else {
      await alertFn?.([
        `⚠️ <b>Bot health check failed</b>`,
        `Service: ${name}`,
        `Error: ${msg.slice(0, 200)}`,
        `Time: ${new Date().toUTCString()}`,
      ].join("\n")).catch(() => {});
    }
    return false;
  }
}

async function runChecks(): Promise<void> {
  if (!WATCHDOG_ENABLED) return;
  await Promise.allSettled([
    check("Database",     () => db.execute(sql`SELECT 1`)),
    check("Bybit API",    () => getBalance()),
    check("Telegram bot", () => checkBotHealth()),
  ]);
}

let _timer: ReturnType<typeof setInterval> | null = null;

export function startWatchdog(): void {
  if (_timer) return;
  _timer = setInterval(() => { void runChecks(); }, INTERVAL_MS);
  console.log("[watchdog] Started — checks every 5 min");
}

export function stopWatchdog(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
