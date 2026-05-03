import { db }                from "@workspace/db";
import { sql }               from "drizzle-orm";
import { getAccountBalance } from "../brokers/okx";
import { getBalance }        from "../brokers/bybit";

const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

let alertFn: ((msg: string) => Promise<void>) | null = null;
export function registerWatchdogAlert(fn: (msg: string) => Promise<void>): void { alertFn = fn; }

async function check(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[watchdog] ❌ ${name}: ${msg}`);
    await alertFn?.([
      `⚠️ <b>Bot health check failed</b>`,
      `Service: ${name}`,
      `Error: ${msg.slice(0, 200)}`,
      `Time: ${new Date().toUTCString()}`,
    ].join("\n")).catch(() => {});
    return false;
  }
}

async function runChecks(): Promise<void> {
  await Promise.allSettled([
    check("Database",    () => db.execute(sql`SELECT 1`)),
    check("OKX API",     () => getAccountBalance()),
    check("Bybit API",   () => getBalance()),
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
