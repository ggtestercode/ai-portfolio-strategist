/**
 * OKX Paper Trading — uses real public market prices, no API keys needed.
 * Fills immediately at current market price, persists positions to disk.
 */

import { createHmac } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { OKXPosition, OKXBalance, OKXOrder } from "./okx";

const BASE       = process.env["OKX_BASE_URL"] ?? "https://www.okx.com";
const STATE_FILE = path.join(process.cwd(), ".paper-positions.json");
const PAPER_EQUITY_USDT = 10_000; // virtual starting balance

// ── Normalise symbol ─────────────────────────────────────────────────────────
function toInstId(symbol: string): string {
  const s = symbol.toUpperCase().replace("/", "-");   // BTC/USDT → BTC-USDT
  if (s.endsWith("-SWAP")) return s;                  // already full instId
  if (s.includes("-USDT")) return `${s}-SWAP`;        // BTC-USDT → BTC-USDT-SWAP
  if (s.includes("-")) return s;                      // other dash format, pass through
  return `${s}-USDT-SWAP`;                            // BTC → BTC-USDT-SWAP
}

// ── Persistence ───────────────────────────────────────────────────────────────
interface PaperPosition {
  id:           string;
  instId:       string;
  side:         "long" | "short";
  sz:           number;   // contracts
  contractSize: number;
  entryPrice:   number;
  leverage:     number;
  notionalUsd:  number;   // amountUsd * leverage (exposure)
  marginUsd:    number;   // amountUsd (collateral posted)
  openedAt:     string;
}

interface PaperState {
  positions: Record<string, PaperPosition>;  // keyed by instId
  equity:    number;
}

function loadState(): PaperState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as PaperState;
    }
  } catch { /* ignore */ }
  return { positions: {}, equity: PAPER_EQUITY_USDT };
}

function saveState(state: PaperState): void {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* ignore */ }
}

let _state: PaperState = loadState();

// ── Public price (no auth) ───────────────────────────────────────────────────
async function getPublicPrice(instId: string): Promise<number> {
  const res  = await fetch(`${BASE}/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`,
    { signal: AbortSignal.timeout(6000) });
  const json = await res.json() as { code: string; data: Array<{ last: string }> };
  if (json.code !== "0" || !json.data[0]) throw new Error(`No ticker for ${instId}`);
  return parseFloat(json.data[0].last);
}

async function getPublicContractSize(instId: string): Promise<number> {
  const res  = await fetch(
    `${BASE}/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`,
    { signal: AbortSignal.timeout(6000) });
  const json = await res.json() as { code: string; data: Array<{ ctVal: string }> };
  if (json.code !== "0" || !json.data[0]) return 0.01; // sensible default
  return parseFloat(json.data[0].ctVal);
}

// ── Core paper trading functions ─────────────────────────────────────────────
export async function openPositionPaper(
  symbol:    string,
  side:      "buy" | "sell",
  amountUsd: number,
  leverage = 10,
): Promise<{ success: boolean; orderId: string; message: string }> {
  const instId = toInstId(symbol);

  const [price, contractSize] = await Promise.all([
    getPublicPrice(instId),
    getPublicContractSize(instId),
  ]);

  const notionalUsd   = amountUsd * leverage;
  const contractValue = contractSize * price;
  const sz            = Math.max(1, Math.round(notionalUsd / contractValue));
  const posSide: "long" | "short" = side === "buy" ? "long" : "short";

  const existing = _state.positions[instId];
  if (existing && existing.side !== posSide) {
    // opposite side — treat as close
    return closePositionPaper(instId);
  }

  const pos: PaperPosition = {
    id: randomUUID(),
    instId,
    side:    posSide,
    sz,
    contractSize,
    entryPrice:  price,
    leverage,
    notionalUsd,
    marginUsd:   amountUsd,
    openedAt:    new Date().toISOString(),
  };

  _state.positions[instId] = pos;
  saveState(_state);

  return {
    success: true,
    orderId: `PAPER-${pos.id.slice(0, 8)}`,
    message: `${side.toUpperCase()} ${instId} — Filled (Paper) @ $${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
  };
}

export async function closePositionPaper(
  instId: string,
): Promise<{ success: boolean; orderId: string; message: string }> {
  const id  = toInstId(instId);
  const pos = _state.positions[id];
  if (!pos) throw new Error(`Paper: no open position for ${id}`);

  const price  = await getPublicPrice(id);
  const pnl    = pos.side === "long"
    ? (price - pos.entryPrice) * pos.sz * pos.contractSize
    : (pos.entryPrice - price) * pos.sz * pos.contractSize;

  delete _state.positions[id];
  _state.equity += pnl;
  saveState(_state);

  const sign = pnl >= 0 ? "+" : "";
  return {
    success: true,
    orderId: `PAPER-CLOSE-${randomUUID().slice(0, 8)}`,
    message: `Closed ${id} @ $${price.toLocaleString("en-US", { maximumFractionDigits: 2 })} · P/L ${sign}$${pnl.toFixed(2)}`,
  };
}

export async function getPositionsPaper(): Promise<OKXPosition[]> {
  const positions = Object.values(_state.positions);
  if (!positions.length) return [];

  // Fetch current prices in parallel
  const prices = await Promise.all(
    positions.map(p => getPublicPrice(p.instId).catch(() => p.entryPrice))
  );

  return positions.map((p, i) => {
    const currentPrice = prices[i]!;
    const pnl = p.side === "long"
      ? (currentPrice - p.entryPrice) * p.sz * p.contractSize
      : (p.entryPrice - currentPrice) * p.sz * p.contractSize;
    const pnlPct = (pnl / p.marginUsd) * 100;
    return {
      positionId: p.id,
      symbol:     p.instId,
      side:       p.side,
      size:       p.sz,
      entryPrice: p.entryPrice,
      pnl,
      pnlPct,
      leverage:   p.leverage,
    };
  });
}

export async function getBalancePaper(): Promise<OKXBalance> {
  const positions = Object.values(_state.positions);

  // Unrealised P&L
  let unrealisedPnl = 0;
  if (positions.length) {
    const prices = await Promise.all(
      positions.map(p => getPublicPrice(p.instId).catch(() => p.entryPrice))
    );
    prices.forEach((price, i) => {
      const p = positions[i]!;
      unrealisedPnl += p.side === "long"
        ? (price - p.entryPrice) * p.sz * p.contractSize
        : (p.entryPrice - price) * p.sz * p.contractSize;
    });
  }

  const usedMargin    = positions.reduce((s, p) => s + p.marginUsd, 0);
  const totalEquity   = _state.equity + unrealisedPnl;
  const available     = Math.max(0, _state.equity - usedMargin);

  return { totalEquity, availableBalance: available, currency: "USDT" };
}

export function getPaperOrdersPaper(): OKXOrder[] {
  return []; // paper fills immediately — no pending orders
}

export function resetPaperAccount(): void {
  _state = { positions: {}, equity: PAPER_EQUITY_USDT };
  saveState(_state);
}
