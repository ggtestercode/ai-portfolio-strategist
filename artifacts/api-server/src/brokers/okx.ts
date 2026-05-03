import { createHmac } from "crypto";

const BASE    = "https://www.okx.com";
const isDemo  = () => process.env["OKX_TRADING_MODE"] === "demo";

function creds() {
  const apiKey     = process.env["OKX_API_KEY"];
  const secretKey  = process.env["OKX_SECRET_KEY"];
  const passphrase = process.env["OKX_PASSPHRASE"];
  if (!apiKey || !secretKey || !passphrase)
    throw new Error("OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE env vars required");
  return { apiKey, secretKey, passphrase };
}

function sign(ts: string, method: string, path: string, body: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(ts + method.toUpperCase() + path + body)
    .digest("base64");
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const { apiKey, secretKey, passphrase } = creds();
  const ts      = new Date().toISOString();
  const bodyStr = body != null ? JSON.stringify(body) : "";
  const fullPath = `/api/v5${path}`;
  const sig = sign(ts, method, fullPath, bodyStr, secretKey);

  const headers: Record<string, string> = {
    "Content-Type":         "application/json",
    "OK-ACCESS-KEY":        apiKey,
    "OK-ACCESS-SIGN":       sig,
    "OK-ACCESS-TIMESTAMP":  ts,
    "OK-ACCESS-PASSPHRASE": passphrase,
  };
  if (isDemo()) headers["x-simulated-trading"] = "1";

  const res = await fetch(`${BASE}${fullPath}`, {
    method,
    headers,
    body: bodyStr || undefined,
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`OKX ${method} ${path} → HTTP ${res.status}: ${text}`);
  }

  const json = await res.json() as { code: string; msg: string; data: T };
  if (json.code !== "0") throw new Error(`OKX ${method} ${path} → code ${json.code}: ${json.msg}`);
  return json.data;
}

// Normalise "BTC" → "BTC-USDT-SWAP", pass through if already formatted
function toInstId(symbol: string): string {
  const s = symbol.toUpperCase();
  return s.includes("-") ? s : `${s}-USDT-SWAP`;
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface OKXTicker {
  symbol:   string;
  bid:      number;
  ask:      number;
  last:     number;
  change24h: number;
}

export interface OKXPosition {
  positionId: string;
  symbol:     string;
  side:       "long" | "short";
  size:       number;
  entryPrice: number;
  pnl:        number;
  pnlPct:     number;
  leverage:   number;
}

export interface OKXOrder {
  orderId:  string;
  symbol:   string;
  side:     "buy" | "sell";
  size:     number;
  price:    number;
  placedAt: string;
}

export interface OKXBalance {
  totalEquity:       number;
  availableBalance:  number;
  currency:          string;
}

export interface OKXInstrument {
  instId:       string;
  contractSize: number;
  maxLeverage:  number;
}

// ── API functions ─────────────────────────────────────────────────────────────

export async function getTicker(symbol: string): Promise<OKXTicker> {
  const instId = toInstId(symbol);
  const data = await request<Array<{
    instId: string; bidPx: string; askPx: string; last: string; open24h: string;
  }>>("GET", `/market/ticker?instId=${encodeURIComponent(instId)}`);
  const d = data[0];
  if (!d) throw new Error(`OKX: no ticker for ${instId}`);
  const last  = parseFloat(d.last);
  const open  = parseFloat(d.open24h);
  return {
    symbol:    instId,
    bid:       parseFloat(d.bidPx),
    ask:       parseFloat(d.askPx),
    last,
    change24h: open ? ((last - open) / open) * 100 : 0,
  };
}

export async function getPositions(): Promise<OKXPosition[]> {
  const data = await request<Array<{
    posId: string; instId: string; posSide: string; pos: string;
    avgPx: string; upl: string; uplRatio: string; lever: string;
  }>>("GET", "/account/positions");
  return (Array.isArray(data) ? data : []).map(p => ({
    positionId: p.posId,
    symbol:     p.instId,
    side:       p.posSide === "short" ? "short" : "long",
    size:       parseFloat(p.pos),
    entryPrice: parseFloat(p.avgPx),
    pnl:        parseFloat(p.upl),
    pnlPct:     parseFloat(p.uplRatio) * 100,
    leverage:   parseFloat(p.lever),
  }));
}

export async function getOrders(): Promise<OKXOrder[]> {
  try {
    const data = await request<Array<{
      ordId: string; instId: string; side: string;
      sz: string; px: string; cTime: string;
    }>>("GET", "/trade/orders-pending?instType=SWAP");
    return (Array.isArray(data) ? data : []).map(o => ({
      orderId:  o.ordId,
      symbol:   o.instId,
      side:     o.side as "buy" | "sell",
      size:     parseFloat(o.sz),
      price:    parseFloat(o.px),
      placedAt: new Date(parseInt(o.cTime)).toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function searchInstrument(symbol: string): Promise<OKXInstrument> {
  const instId = toInstId(symbol);
  const data   = await request<Array<{
    instId: string; ctVal: string; lever: string;
  }>>("GET", `/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`);
  const d = data[0];
  if (!d) throw new Error(`OKX: instrument not found for ${instId}`);
  return {
    instId,
    contractSize: parseFloat(d.ctVal),
    maxLeverage:  parseFloat(d.lever),
  };
}

export async function setLeverage(instId: string, leverage: number): Promise<void> {
  await request("POST", "/account/set-leverage", {
    instId,
    lever:   String(leverage),
    mgnMode: "cross",
  });
}

export async function openPosition(
  symbol:    string,
  side:      "buy" | "sell",
  amountUsd: number,
  leverage = 10,
): Promise<{ success: boolean; orderId: string; message: string }> {
  const instId = toInstId(symbol);

  const [instrument, ticker] = await Promise.all([
    searchInstrument(instId),
    getTicker(instId),
  ]);

  await setLeverage(instId, Math.min(leverage, instrument.maxLeverage)).catch(() => {});

  // sz = number of contracts to get ~amountUsd exposure at leverage
  const contractValueUsd = instrument.contractSize * ticker.last;
  const sz = Math.max(1, Math.round((amountUsd * leverage) / contractValueUsd));

  const data = await request<Array<{
    ordId: string; sCode: string; sMsg: string;
  }>>("POST", "/trade/order", {
    instId,
    tdMode:  "cross",
    side,
    ordType: "market",
    sz:      String(sz),
    lever:   String(Math.min(leverage, instrument.maxLeverage)),
  });

  const result = data[0];
  if (!result || result.sCode !== "0") {
    throw new Error(`OKX order failed: ${result?.sMsg ?? "unknown"}`);
  }

  const mode = isDemo() ? "Demo" : "Live";
  return {
    success: true,
    orderId: result.ordId,
    message: `${side.toUpperCase()} ${instId} — Executed (${mode})`,
  };
}

export async function closePosition(instId: string): Promise<{ success: boolean; orderId: string }> {
  const id = toInstId(instId);
  const data = await request<Array<{
    ordId: string; sCode: string; sMsg: string;
  }>>("POST", "/trade/close-position", {
    instId:  id,
    mgnMode: "cross",
  });
  const result = data[0];
  if (!result || result.sCode !== "0") {
    throw new Error(`OKX close failed: ${result?.sMsg ?? "unknown"}`);
  }
  return { success: true, orderId: result.ordId };
}

export async function getAccountBalance(): Promise<OKXBalance> {
  const data = await request<Array<{
    totalEq: string;
    adjEq:   string;
    details: Array<{ ccy: string; availEq: string }>;
  }>>("GET", "/account/balance");
  const d = data[0];
  if (!d) throw new Error("OKX: no balance data");
  const usdt = d.details.find(x => x.ccy === "USDT");
  return {
    totalEquity:      parseFloat(d.totalEq),
    availableBalance: parseFloat(usdt?.availEq ?? d.adjEq),
    currency:         "USDT",
  };
}

// Candle data for market scanner
export async function getCandles(instId: string, limit = 30): Promise<Array<{
  ts: number; open: number; high: number; low: number; close: number; vol: number;
}>> {
  const id   = toInstId(instId);
  const data = await request<string[][]>(
    "GET", `/market/candles?instId=${encodeURIComponent(id)}&bar=1D&limit=${limit}`
  );
  return (Array.isArray(data) ? data : []).map(r => ({
    ts:    parseInt(r[0] ?? "0"),
    open:  parseFloat(r[1] ?? "0"),
    high:  parseFloat(r[2] ?? "0"),
    low:   parseFloat(r[3] ?? "0"),
    close: parseFloat(r[4] ?? "0"),
    vol:   parseFloat(r[5] ?? "0"),
  }));
}
