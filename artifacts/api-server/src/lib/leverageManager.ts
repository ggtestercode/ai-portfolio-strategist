import { db, botStateTable, profileTable, type CoinPenalty } from "@workspace/db";
import { eq } from "drizzle-orm";

const PORTFOLIO_START     = 10;
const PORTFOLIO_CEILING   = 100;
const PENALTY_LOSS_STEP   = 10;  // leverage penalty per 30%+ loss
const FLOOR_LEVERAGE      = 10;
const SUSPENSION_HITS     = 3;   // consecutive floor hits before suspension

let alertFn: ((msg: string) => Promise<void>) | null = null;
export function registerLeverageAlert(fn: (msg: string) => Promise<void>): void { alertFn = fn; }

// ── State helpers ─────────────────────────────────────────────────────────────
async function loadState() {
  const [row] = await db.select().from(botStateTable).limit(1);
  if (row) return row;
  // Bootstrap row if missing
  await db.insert(botStateTable).values({ id: 1 }).onConflictDoNothing();
  const [fresh] = await db.select().from(botStateTable).limit(1);
  return fresh!;
}

async function saveState(patch: Partial<typeof botStateTable.$inferInsert>): Promise<void> {
  await db.update(botStateTable).set({ ...patch, lastUpdated: new Date() }).where(eq(botStateTable.id, 1));
}

// ── Portfolio-level leverage ──────────────────────────────────────────────────
export async function getPortfolioLeverage(): Promise<number> {
  const state = await loadState();
  return state.portfolioLeverage;
}

export async function checkPortfolioLeverage(): Promise<number> {
  const [state, profile] = await Promise.all([
    loadState(),
    db.select({ totalCapital: profileTable.totalCapital }).from(profileTable).limit(1).then(r => r[0]),
  ]);

  if (!profile) return state.portfolioLeverage;

  const capital  = profile.totalCapital;
  const dailyPnl = state.dailyPnl;
  const pnlPct   = capital > 0 ? (dailyPnl / capital) * 100 : 0;

  let leverage = state.portfolioLeverage;

  if (pnlPct > 30 && leverage < PORTFOLIO_CEILING) {
    leverage = Math.min(leverage + 10, PORTFOLIO_CEILING);
    await saveState({ portfolioLeverage: leverage });
    console.log(`[leverage] Portfolio +10x → ${leverage}x (daily P/L ${pnlPct.toFixed(1)}%)`);
  } else if (pnlPct < 10 && leverage > PORTFOLIO_START) {
    leverage = Math.max(leverage - 10, PORTFOLIO_START);
    await saveState({ portfolioLeverage: leverage });
    console.log(`[leverage] Portfolio -10x → ${leverage}x (daily P/L ${pnlPct.toFixed(1)}%)`);
  }

  return leverage;
}

// ── Per-coin leverage ─────────────────────────────────────────────────────────
export async function getLeverageForCoin(symbol: string): Promise<number> {
  const [state, portfolio] = await Promise.all([
    loadState(),
    checkPortfolioLeverage(),
  ]);
  const penalty  = (state.coinPenalties as Record<string, CoinPenalty>)[symbol];
  if (penalty?.suspended) throw new Error(`${symbol} is suspended — use /resume ${symbol} to unsuspend`);
  const penaltyLev = penalty ? penalty.penalty * PENALTY_LOSS_STEP : 0;
  return Math.max(portfolio - penaltyLev, FLOOR_LEVERAGE);
}

export async function isCoinSuspended(symbol: string): Promise<boolean> {
  const state   = await loadState();
  const penalty = (state.coinPenalties as Record<string, CoinPenalty>)[symbol];
  return penalty?.suspended ?? false;
}

// ── Record closed trade outcome ───────────────────────────────────────────────
export async function recordTradeOutcome(symbol: string, pnlPct: number): Promise<void> {
  const state    = await loadState();
  const penalties = { ...(state.coinPenalties as Record<string, CoinPenalty>) };
  const current   = penalties[symbol] ?? { penalty: 0, consecutiveHits: 0, suspended: false };

  if (pnlPct <= -30) {
    // Penalise
    const newPenalty  = current.penalty + 1;
    const consec      = current.consecutiveHits + 1;
    const suspended   = consec >= SUSPENSION_HITS;

    penalties[symbol] = { penalty: newPenalty, consecutiveHits: consec, suspended };
    await saveState({ coinPenalties: penalties });

    const effectiveLev = Math.max(state.portfolioLeverage - newPenalty * PENALTY_LOSS_STEP, FLOOR_LEVERAGE);
    console.log(`[leverage] ${symbol} penalty +1 → effective ${effectiveLev}x (loss ${pnlPct.toFixed(1)}%)`);

    if (suspended) {
      await alertFn?.(`🚫 ${symbol} suspended after ${SUSPENSION_HITS} consecutive losses.\nUse /resume ${symbol} to re-enable.`).catch(() => {});
    } else if (consec === 2) {
      await alertFn?.(`⚠️ ${symbol}: 2nd consecutive loss — one more will suspend this coin.`).catch(() => {});
    }
  } else if (pnlPct >= 0 && current.penalty > 0) {
    // Recovery: winning trade restores penalty if profit ≥ 70% of prior loss offset
    const restored    = Math.max(current.penalty - 1, 0);
    penalties[symbol] = { ...current, penalty: restored, consecutiveHits: 0 };
    await saveState({ coinPenalties: penalties });
    console.log(`[leverage] ${symbol} recovered — penalty ${current.penalty} → ${restored}`);
  }
}

export async function unsuspendCoin(symbol: string): Promise<void> {
  const state     = await loadState();
  const penalties = { ...(state.coinPenalties as Record<string, CoinPenalty>) };
  if (penalties[symbol]) {
    penalties[symbol] = { ...penalties[symbol]!, suspended: false, consecutiveHits: 0 };
    await saveState({ coinPenalties: penalties });
    console.log(`[leverage] ${symbol} unsuspended`);
  }
}

export async function updateDailyPnl(pnl: number): Promise<void> {
  await saveState({ dailyPnl: pnl });
}

export async function getSuspendedCoins(): Promise<string[]> {
  const state = await loadState();
  return Object.entries(state.coinPenalties as Record<string, CoinPenalty>)
    .filter(([, v]) => v.suspended)
    .map(([k]) => k);
}
