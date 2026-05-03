import { createHmac } from "crypto";

// ── Config ────────────────────────────────────────────────────────────────────
const BYBIT_TRADING_MODE = process.env["BYBIT_TRADING_MODE"] ?? "testnet";
const BASE_URL = BYBIT_TRADING_MODE === "live"
  ? "https://api.bybit.com"
  : "https://api-testnet.bybit.com";

console.log(`[Bybit] mode=${BYBIT_TRADING_MODE} base=${BASE_URL}`);

function creds() {
  const key    = process.env["BYBIT_API_KEY"];
  const secret = process.env["BYBIT_API_SECRET"];
  if (!key || !secret) throw new Error("BYBIT_API_KEY and BYBIT_API_SECRET env vars required");
  return { key, secret };
}

const RW = "5000";

function sign(secret: string, ts: string, key: string, payload: string): string {
  return createHmac("sha256", secret).update(ts + key + RW + payload).digest("hex");
}

async function get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const { key, secret } = creds();
  const qs  = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const ts  = Date.now().toString();
  const sig = sign(secret, ts, key, qs);
  const res = await fetch(`${BASE_URL}${path}${qs ? "?" + qs : ""}`, {
    headers: {
      "X-BAPI-API-KEY": key, "X-BAPI-SIGN": sig,
      "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": RW,
    },
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json() as { retCode: number; retMsg: string; result: T };
  if (json.retCode !== 0) throw new Error(`Bybit GET ${path} → ${json.retCode}: ${json.retMsg}`);
  return json.result;
}

async function bpost<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const { key, secret } = creds();
  const bodyStr = JSON.stringify(body);
  const ts      = Date.now().toString();
  const sig     = sign(secret, ts, key, bodyStr);
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": key, "X-BAPI-SIGN": sig,
      "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": RW,
    },
    body: bodyStr,
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json() as { retCode: number; retMsg: string; result: T };
  if (json.retCode !== 0) throw new Error(`Bybit POST ${path} → ${json.retCode}: ${json.retMsg}`);
  return json.result;
}

function normalise(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[-/]/g, "").replace(/[^A-Z0-9]/g, "");
  if (!s.endsWith("USDT") && !s.endsWith("USDC")) return `${s}USDT`;
  return s;
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface BybitTicker  { symbol: string; lastPrice: number; bid: number; ask: number; change24h: number }
export interface BybitPosition { symbol: string; side: "Buy" | "Sell" | "None"; size: number; entryPrice: number; leverage: number; pnl: number; pnlPct: number }
export interface BybitOrder   { orderId: string; symbol: string; side: string; qty: number; price: number; placedAt: string }
export interface BybitBalance { totalEquity: number; availableBalance: number; currency: string }
export interface BybitKline   { ts: number; open: number; high: number; low: number; close: number; volume: number }

// ── Market ────────────────────────────────────────────────────────────────────
export async function getTicker(symbol: string): Promise<BybitTicker> {
  const sym = normalise(symbol);
  const r   = await get<{ list: Array<{ symbol: string; lastPrice: string; bid1Price: string; ask1Price: string; price24hPcnt: string }> }>(
    "/v5/market/tickers", { category: "linear", symbol: sym }
  );
  const d = r.list[0];
  if (!d) throw new Error(`Bybit: no ticker for ${sym}`);
  return { symbol: d.symbol, lastPrice: parseFloat(d.lastPrice), bid: parseFloat(d.bid1Price), ask: parseFloat(d.ask1Price), change24h: parseFloat(d.price24hPcnt) * 100 };
}

export async function getKlines(symbol: string, interval: string, limit = 50): Promise<BybitKline[]> {
  const r = await get<{ list: string[][] }>(
    "/v5/market/kline", { category: "linear", symbol: normalise(symbol), interval, limit }
  );
  return r.list.map(c => ({
    ts: parseInt(c[0] ?? "0"), open: parseFloat(c[1] ?? "0"), high: parseFloat(c[2] ?? "0"),
    low: parseFloat(c[3] ?? "0"), close: parseFloat(c[4] ?? "0"), volume: parseFloat(c[5] ?? "0"),
  })).reverse();
}

export async function getAllSymbols(): Promise<string[]> {
  const r = await get<{ list: Array<{ symbol: string; status: string; quoteCoin: string }> }>(
    "/v5/market/instruments-info", { category: "linear", limit: 500 }
  ).catch(() => ({ list: [] as Array<{ symbol: string; status: string; quoteCoin: string }> }));
  return r.list.filter(s => s.status === "Trading" && s.quoteCoin === "USDT").map(s => s.symbol);
}

// ── Account ───────────────────────────────────────────────────────────────────
export async function getPositions(): Promise<BybitPosition[]> {
  const r = await get<{ list: Array<{ symbol: string; side: string; size: string; avgPrice: string; leverage: string; unrealisedPnl: string }> }>(
    "/v5/position/list", { category: "linear", settleCoin: "USDT" }
  );
  return r.list.filter(p => parseFloat(p.size) > 0).map(p => {
    const entry = parseFloat(p.avgPrice);
    const pnl   = parseFloat(p.unrealisedPnl);
    const cost  = parseFloat(p.size) * entry;
    return { symbol: p.symbol, side: p.side as "Buy" | "Sell", size: parseFloat(p.size), entryPrice: entry, leverage: parseFloat(p.leverage), pnl, pnlPct: cost > 0 ? (pnl / cost) * 100 : 0 };
  });
}

export async function getOrders(): Promise<BybitOrder[]> {
  const r = await get<{ list: Array<{ orderId: string; symbol: string; side: string; qty: string; price: string; createdTime: string }> }>(
    "/v5/order/realtime", { category: "linear" }
  ).catch(() => ({ list: [] as Array<{ orderId: string; symbol: string; side: string; qty: string; price: string; createdTime: string }> }));
  return r.list.map(o => ({ orderId: o.orderId, symbol: o.symbol, side: o.side, qty: parseFloat(o.qty), price: parseFloat(o.price), placedAt: new Date(parseInt(o.createdTime)).toISOString() }));
}

export async function getBalance(): Promise<BybitBalance> {
  const r = await get<{ list: Array<{ totalEquity: string; totalAvailableBalance: string }> }>(
    "/v5/account/wallet-balance", { accountType: "UNIFIED" }
  );
  const d = r.list[0];
  if (!d) throw new Error("Bybit: no balance data");
  return { totalEquity: parseFloat(d.totalEquity), availableBalance: parseFloat(d.totalAvailableBalance), currency: "USDT" };
}

// ── Trading ───────────────────────────────────────────────────────────────────
export async function setLeverage(symbol: string, leverage: number): Promise<void> {
  const sym = normalise(symbol);
  await bpost("/v5/position/set-leverage", { category: "linear", symbol: sym, buyLeverage: String(leverage), sellLeverage: String(leverage) })
    .catch(e => { if (!e.message.includes("110043")) throw e; }); // 110043 = leverage not modified
}

export async function openPosition(symbol: string, side: "Buy" | "Sell", amountUsd: number, leverage = 10): Promise<{ orderId: string }> {
  const sym    = normalise(symbol);
  await setLeverage(sym, leverage);
  const ticker = await getTicker(sym);
  const qty    = (amountUsd / ticker.lastPrice).toFixed(3);
  const r      = await bpost<{ orderId: string }>("/v5/order/create", { category: "linear", symbol: sym, side, orderType: "Market", qty, timeInForce: "GoodTillCancel", reduceOnly: false });
  console.log(`[Bybit] ${side} ${sym} qty=${qty} @~$${ticker.lastPrice.toFixed(2)} leverage=${leverage}x orderId=${r.orderId}`);
  return { orderId: r.orderId };
}

export async function closePosition(symbol: string): Promise<{ orderId: string }> {
  const sym       = normalise(symbol);
  const positions = await getPositions();
  const pos       = positions.find(p => p.symbol === sym);
  if (!pos || pos.size <= 0) throw new Error(`Bybit: no open position for ${sym}`);
  const closeSide = pos.side === "Buy" ? "Sell" : "Buy";
  const r = await bpost<{ orderId: string }>("/v5/order/create", { category: "linear", symbol: sym, side: closeSide, orderType: "Market", qty: String(pos.size), reduceOnly: true });
  console.log(`[Bybit] Close ${sym} qty=${pos.size} orderId=${r.orderId}`);
  return { orderId: r.orderId };
}

export async function setTrailingStop(symbol: string, trailingPct = 0.40): Promise<void> {
  const sym    = normalise(symbol);
  const ticker = await getTicker(sym).catch(() => null);
  if (!ticker) return;
  const trail  = (ticker.lastPrice * trailingPct).toFixed(2);
  await bpost("/v5/position/trading-stop", { category: "linear", symbol: sym, trailingStop: trail, positionIdx: 0 })
    .catch(e => console.warn(`[Bybit] setTrailingStop ${sym}: ${e.message}`));
  console.log(`[Bybit] Trailing stop ${trailingPct * 100}% on ${sym} ≈ $${trail}`);
}

export async function setStopLoss(symbol: string, stopLossPrice: number): Promise<void> {
  const sym = normalise(symbol);
  await bpost("/v5/position/trading-stop", { category: "linear", symbol: sym, stopLoss: String(stopLossPrice), positionIdx: 0 })
    .catch(e => console.warn(`[Bybit] setStopLoss ${sym}: ${e.message}`));
}

// ── Backward-compat wrapper ───────────────────────────────────────────────────
export async function placeOrder(symbol: string, side: "Buy" | "Sell", amountUsd: number): Promise<{ orderId?: string }> {
  return openPosition(symbol, side, amountUsd, 1);
}
