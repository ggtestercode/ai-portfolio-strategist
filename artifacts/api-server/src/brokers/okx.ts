import { createHmac } from "crypto";
import * as fs from "fs";
import * as path from "path";

const BASE    = process.env["OKX_BASE_URL"] ?? "https://www.okx.com";

// ── Entry price tracker (spot positions have no exchange-side entry price) ────
const ENTRY_FILE = path.join(process.cwd(), ".okx-entries.json");

function loadEntries(): Record<string, { entryPrice: number; size: number; costBasis: number }> {
  try { return JSON.parse(fs.readFileSync(ENTRY_FILE, "utf8")); } catch { return {}; }
}
function saveEntries(e: Record<string, { entryPrice: number; size: number; costBasis: number }>): void {
  try { fs.writeFileSync(ENTRY_FILE, JSON.stringify(e, null, 2)); } catch { /* ignore */ }
}
function recordBuy(spotId: string, price: number, qty: number): void {
  const entries = loadEntries();
  const existing = entries[spotId];
  if (existing) {
    // Average down/up: weighted avg entry price
    const totalQty  = existing.size + qty;
    const totalCost = existing.costBasis + price * qty;
    entries[spotId] = { entryPrice: totalCost / totalQty, size: totalQty, costBasis: totalCost };
  } else {
    entries[spotId] = { entryPrice: price, size: qty, costBasis: price * qty };
  }
  saveEntries(entries);
}
function clearEntry(spotId: string): void {
  const entries = loadEntries();
  delete entries[spotId];
  saveEntries(entries);
}
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

// Like request() but returns data without throwing on non-zero top-level sCode
// (order endpoints return code=1 with per-item sCodes when something fails)
async function requestRaw<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const { apiKey, secretKey, passphrase } = creds();
  const ts      = new Date().toISOString();
  const bodyStr = body != null ? JSON.stringify(body) : "";
  const fullPath = `/api/v5${path}`;
  const sig = sign(ts, method, fullPath, bodyStr, secretKey);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": apiKey, "OK-ACCESS-SIGN": sig,
    "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": passphrase,
  };
  if (isDemo()) headers["x-simulated-trading"] = "1";
  const res = await fetch(`${BASE}${fullPath}`, {
    method, headers, body: bodyStr || undefined, signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`OKX ${method} ${path} → HTTP ${res.status}: ${text}`);
  }
  const json = await res.json() as { code: string; msg: string; data: T };
  return json.data;
}

async function probeKey(
  apiKey: string, secretKey: string, passphrase: string, simulated: boolean
): Promise<"ok" | "bad_key" | "bad_sig" | "other"> {
  try {
    const ts  = new Date().toISOString();
    const sig = sign(ts, "GET", "/api/v5/account/balance", "", secretKey);
    const headers: Record<string, string> = {
      "Content-Type":         "application/json",
      "OK-ACCESS-KEY":        apiKey,
      "OK-ACCESS-SIGN":       sig,
      "OK-ACCESS-TIMESTAMP":  ts,
      "OK-ACCESS-PASSPHRASE": passphrase,
    };
    if (simulated) headers["x-simulated-trading"] = "1";
    const res  = await fetch(`${BASE}/api/v5/account/balance`, { headers, signal: AbortSignal.timeout(6000) });
    const json = await res.json() as { code: string };
    if (json.code === "0")    return "ok";
    if (json.code === "50119") return "bad_key";
    if (json.code === "50113") return "bad_sig";
    return "other";
  } catch {
    return "other";
  }
}

export async function testConnection(): Promise<{
  ok: boolean; lines: string[];
}> {
  const demoKey  = process.env["OKX_API_KEY"]      ?? "";
  const demaSec  = process.env["OKX_SECRET_KEY"]   ?? "";
  const demoPass = process.env["OKX_PASSPHRASE"]   ?? "";
  const liveKey  = process.env["OKX_LIVE_API_KEY"]      ?? "";
  const liveSec  = process.env["OKX_LIVE_SECRET_KEY"]   ?? "";
  const livePass = process.env["OKX_LIVE_PASSPHRASE"]   ?? "";

  const [demoOnSim, demoOnLive, liveOnLive] = await Promise.all([
    probeKey(demoKey, demaSec, demoPass, true),
    probeKey(demoKey, demaSec, demoPass, false),
    probeKey(liveKey, liveSec, livePass, false),
  ]);

  const lines: string[] = [];
  const fmt = (label: string, r: string) => {
    if (r === "ok")      return `✅ ${label}: Connected`;
    if (r === "bad_key") return `❌ ${label}: Key not found (50119)`;
    if (r === "bad_sig") return `⚠️ ${label}: Bad signature (50113)`;
    return `❌ ${label}: Error`;
  };

  lines.push(fmt(`Demo key (${demoKey.slice(0,8)}…) on sim`, demoOnSim));
  lines.push(fmt(`Demo key on live`, demoOnLive));
  lines.push(fmt(`Live key (${liveKey.slice(0,8)}…) on live`, liveOnLive));

  const anyOk = demoOnSim === "ok" || demoOnLive === "ok" || liveOnLive === "ok";

  if (!anyOk) {
    lines.push(``, `💡 <b>All keys rejected.</b> Likely cause:`);
    lines.push(`OKX may require IP whitelisting. Check your API key settings on OKX and add this server's IP, or set "Unrestricted" access.`);
    lines.push(`Alternatively, re-create the API key at OKX → Simulated Trading → Account → API Management.`);
  } else if (demoOnLive === "ok" && demoOnSim !== "ok") {
    lines.push(``, `💡 Demo key works on LIVE but not simulated. Re-create it inside OKX Simulated Trading.`);
  }

  return { ok: anyOk, lines };
}

// Normalise to SWAP instId (derivatives)
function toSwapId(symbol: string): string {
  const s = symbol.toUpperCase().replace("/", "-");
  if (s.endsWith("-SWAP")) return s;
  if (s.includes("-USDT")) return `${s}-SWAP`;
  if (s.includes("-")) return s;
  return `${s}-USDT-SWAP`;
}

// Normalise to spot instId: BTC / BTC-USDT-SWAP / BTC/USDT → BTC-USDT
function toSpotId(symbol: string): string {
  const s = symbol.toUpperCase().replace("/", "-").replace("-SWAP", "");
  return s.includes("-") ? s : `${s}-USDT`;
}

function toInstId(symbol: string): string { return toSpotId(symbol); }

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
  // Derivative positions
  const swapPositions = await request<Array<{
    posId: string; instId: string; posSide: string; pos: string;
    avgPx: string; upl: string; uplRatio: string; lever: string;
  }>>("GET", "/account/positions").catch(() => []);

  const derivs = (Array.isArray(swapPositions) ? swapPositions : []).map(p => ({
    positionId: p.posId,
    symbol:     p.instId,
    side:       p.posSide === "short" ? "short" as const : "long" as const,
    size:       parseFloat(p.pos),
    entryPrice: parseFloat(p.avgPx),
    pnl:        parseFloat(p.upl),
    pnlPct:     parseFloat(p.uplRatio) * 100,
    leverage:   parseFloat(p.lever),
  }));

  // Spot holdings (balances > 0, excluding stablecoins)
  const STABLES = new Set(["USDT","USDC","USD","SGD","EUR","GBP","BUSD","DAI","TUSD"]);
  const balData = await request<Array<{
    details: Array<{ ccy: string; cashBal: string; availBal: string }>;
  }>>("GET", "/account/balance").catch(() => []);
  const details = (Array.isArray(balData) ? balData[0]?.details : []) ?? [];

  const spotPrices = await Promise.all(
    details
      .filter(d => !STABLES.has(d.ccy) && parseFloat(d.cashBal ?? "0") > 0.00001)
      .map(async d => {
        try {
          const t = await getTicker(`${d.ccy}-USDT`);
          return { ccy: d.ccy, bal: parseFloat(d.cashBal), price: t.last };
        } catch { return null; }
      })
  );

  const entries = loadEntries();

  const spots: OKXPosition[] = spotPrices
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .map(x => {
      const key        = `${x.ccy}-USDT`;
      const entry      = entries[key];
      const entryPrice = entry?.entryPrice ?? x.price;
      const pnl        = entry ? (x.price - entryPrice) * x.bal : 0;
      const pnlPct     = entry ? ((x.price - entryPrice) / entryPrice) * 100 : 0;
      return {
        positionId: `spot-${x.ccy}`,
        symbol:     key,
        side:       "long" as const,
        size:       x.bal,
        entryPrice,
        pnl,
        pnlPct,
        leverage:   1,
      };
    });

  return [...derivs, ...spots];
}

export async function getOrders(): Promise<OKXOrder[]> {
  type RawOrder = { ordId: string; instId: string; side: string; sz: string; px: string; cTime: string };
  const toRows = (data: RawOrder[]) => (Array.isArray(data) ? data : []).map(o => ({
    orderId:  o.ordId,
    symbol:   o.instId,
    side:     o.side as "buy" | "sell",
    size:     parseFloat(o.sz),
    price:    parseFloat(o.px),
    placedAt: new Date(parseInt(o.cTime)).toISOString(),
  }));
  const [spot, swap] = await Promise.allSettled([
    request<RawOrder[]>("GET", "/trade/orders-pending?instType=SPOT"),
    request<RawOrder[]>("GET", "/trade/orders-pending?instType=SWAP"),
  ]);
  return [
    ...(spot.status === "fulfilled" ? toRows(spot.value) : []),
    ...(swap.status === "fulfilled" ? toRows(swap.value) : []),
  ];
}

export async function cancelOrder(instId: string, ordId: string): Promise<void> {
  const raw = await requestRaw<Array<{ sCode: string; sMsg: string }>>(
    "POST", "/trade/cancel-order", { instId, ordId }
  );
  const r = raw[0];
  if (r && r.sCode !== "0") throw new Error(`OKX cancel ${ordId}: ${r.sMsg}`);
}

export async function cancelAllOrders(): Promise<number> {
  const orders = await getOrders();
  if (!orders.length) return 0;
  await Promise.all(orders.map(o => cancelOrder(o.symbol, o.orderId).catch(() => {})));
  return orders.length;
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

export async function setPositionMode(mode: "long_short_mode" | "net_mode" = "long_short_mode"): Promise<void> {
  const data = await request<Array<{ posMode: string }>>(
    "POST", "/account/set-position-mode", { posMode: mode }
  );
  console.log(`[OKX] Position mode set to: ${data[0]?.posMode ?? mode}`);
}

// ── Spot order (cash mode, no leverage) ──────────────────────────────────────
// Quote currencies to try in order for spot buys (picks first with enough balance)
const QUOTE_PRIORITY = ["USDT", "SGD", "USDC", "USD"];

async function getQuoteBalance(): Promise<Record<string, number>> {
  const data = await request<Array<{
    details: Array<{ ccy: string; cashBal: string }>;
  }>>("GET", "/account/balance");
  const details = data[0]?.details ?? [];
  return Object.fromEntries(details.map(d => [d.ccy, parseFloat(d.cashBal ?? "0")]));
}

async function getUsdRate(quote: string): Promise<number> {
  if (quote === "USDT" || quote === "USD") return 1;
  try {
    const t = await getTicker(`${quote}-USDT`);
    return 1 / t.last;   // how many USD per 1 quote unit
  } catch {
    // fall back to known approximate rates
    if (quote === "SGD") return 0.74;
    return 1;
  }
}

async function openSpotPosition(
  symbol: string,
  side:   "buy" | "sell",
  amountUsd: number,
): Promise<{ success: boolean; orderId: string; message: string; entryPrice: number }> {
  const base    = toSpotId(symbol).split("-")[0] ?? "BTC";
  const ticker  = await getTicker(`${base}-USDT`).catch(() => ({ last: 1 }));
  const mode    = isDemo() ? "Demo" : "Live";

  if (side === "sell") {
    for (const quote of ["USDT", "SGD"]) {
      const instId = `${base}-${quote}`;
      const baseSz = (amountUsd / ticker.last).toFixed(8);
      const raw = await requestRaw<Array<{ ordId: string; sCode: string; sMsg: string }>>(
        "POST", "/trade/order",
        { instId, tdMode: "cash", side: "sell", ordType: "market", sz: baseSz, tgtCcy: "base_ccy" }
      );
      const r = raw[0];
      if (r?.sCode === "0") {
        return { success: true, orderId: r.ordId, entryPrice: ticker.last,
                 message: `SELL ${instId} — Spot (${mode}) @ ~$${ticker.last.toLocaleString("en-US", { maximumFractionDigits: 2 })}` };
      }
      if (r?.sCode === "51155") continue;
      throw new Error(`OKX spot sell failed: ${r?.sMsg ?? "unknown"}`);
    }
    throw new Error(`OKX: no available quote currency for selling ${base}`);
  }

  const balances = await getQuoteBalance();

  for (const quote of QUOTE_PRIORITY) {
    const instId   = `${base}-${quote}`;
    const rate     = await getUsdRate(quote);
    const quoteSz  = (amountUsd / rate).toFixed(2);
    const avail    = balances[quote] ?? 0;

    if (avail < parseFloat(quoteSz)) continue;

    const raw = await requestRaw<Array<{ ordId: string; sCode: string; sMsg: string }>>(
      "POST", "/trade/order",
      { instId, tdMode: "cash", side: "buy", ordType: "market", sz: quoteSz, tgtCcy: "quote_ccy" }
    );
    const r = raw[0];
    if (r?.sCode === "0") {
      const qty = amountUsd / ticker.last;
      recordBuy(`${base}-USDT`, ticker.last, qty);
      return { success: true, orderId: r.ordId, entryPrice: ticker.last,
               message: `BUY ${instId} — Spot (${mode}) @ ~$${ticker.last.toLocaleString("en-US", { maximumFractionDigits: 2 })}` };
    }
    if (r?.sCode === "51155" || r?.sCode === "51008") continue;
    throw new Error(`OKX spot buy failed: ${r?.sMsg ?? "unknown"}`);
  }

  throw new Error(`OKX: no available quote currency with sufficient balance to buy ${base}`);
}

// OKX spot-only trading (SG compliance: SWAP/perpetuals not permitted)
export async function openPosition(
  symbol:    string,
  side:      "buy" | "sell",
  amountUsd: number,
  _leverage = 10,
): Promise<{ success: boolean; orderId: string; message: string; entryPrice: number }> {
  return openSpotPosition(symbol, side, amountUsd);
}

export async function openLimitPosition(
  symbol:     string,
  side:       "buy" | "sell",
  amountUsd:  number,
  limitPrice: number,
): Promise<{ success: boolean; orderId: string; message: string }> {
  const base   = toSpotId(symbol).split("-")[0] ?? "BTC";
  const instId = `${base}-USDT`;
  const mode   = isDemo() ? "Demo" : "Live";
  const sz     = (amountUsd / limitPrice).toFixed(8); // base qty at limit price

  const raw = await requestRaw<Array<{ ordId: string; sCode: string; sMsg: string }>>(
    "POST", "/trade/order",
    { instId, tdMode: "cash", side, ordType: "limit", sz, tgtCcy: "base_ccy", px: String(limitPrice) }
  );
  const r = raw[0];
  if (r?.sCode !== "0") throw new Error(`OKX limit ${side} failed: ${r?.sMsg ?? "unknown"}`);
  console.log(`[OKX] Limit ${side} ${instId} sz=${sz} @$${limitPrice} → orderId=${r.ordId}`);
  return { success: true, orderId: r.ordId,
           message: `Limit ${side.toUpperCase()} ${instId} @ $${limitPrice} (${mode})` };
}

export async function closePosition(instId: string): Promise<{ success: boolean; orderId: string; message?: string }> {
  const spotId = toSpotId(instId);
  const base   = spotId.split("-")[0] ?? "BTC";

  // Get available balance for this asset
  const balData = await request<Array<{
    details: Array<{ ccy: string; availBal: string; cashBal: string }>;
  }>>("GET", "/account/balance");
  const detail = balData[0]?.details.find(d => d.ccy === base);
  const sz     = parseFloat(detail?.availBal ?? detail?.cashBal ?? "0");
  if (!sz || sz <= 0) throw new Error(`OKX: no ${base} balance to sell`);

  // Sell entire base balance, try quote currencies in priority order
  for (const quote of ["USDT", "SGD", "USDC", "USD"]) {
    const raw = await requestRaw<Array<{ ordId: string; sCode: string; sMsg: string }>>(
      "POST", "/trade/order", {
        instId: `${base}-${quote}`, tdMode: "cash", side: "sell",
        ordType: "market", sz: sz.toFixed(8), tgtCcy: "base_ccy",
      }
    );
    const r = raw[0];
    if (r?.sCode === "0") {
      clearEntry(`${base}-USDT`);
      console.log(`[OKX] Spot close: sold ${sz.toFixed(6)} ${base} → ${quote} ordId=${r.ordId}`);
      return { success: true, orderId: r.ordId, message: `Sold ${sz.toFixed(6)} ${base}` };
    }
    if (r?.sCode === "51155") continue; // restricted pair, try next quote
  }
  throw new Error(`OKX: could not close ${base} — no valid quote currency pair available`);
}

export async function closeByUnits(instId: string, units: number): Promise<{ orderId: string }> {
  const base   = toSpotId(instId).split("-")[0] ?? "BTC";
  const sz     = units.toFixed(8);
  for (const quote of ["USDT", "SGD", "USDC", "USD"]) {
    const raw = await requestRaw<Array<{ ordId: string; sCode: string; sMsg: string }>>(
      "POST", "/trade/order",
      { instId: `${base}-${quote}`, tdMode: "cash", side: "sell", ordType: "market", sz, tgtCcy: "base_ccy" }
    );
    const r = raw[0];
    if (r?.sCode === "0") {
      console.log(`[OKX] Sell ${sz} ${base} → ${quote} ordId=${r.ordId}`);
      return { orderId: r.ordId };
    }
    if (r?.sCode === "51155") continue;
    throw new Error(`OKX sell ${units} ${base} failed: ${r?.sMsg ?? "unknown"}`);
  }
  throw new Error(`OKX: no valid quote pair for selling ${base}`);
}

export async function getAccountBalance(): Promise<OKXBalance> {
  const data = await request<Array<{
    totalEq: string;
    adjEq:   string;
    details: Array<{ ccy: string; availBal: string; availEq: string; cashBal: string }>;
  }>>("GET", "/account/balance");
  const d = data[0];
  if (!d) throw new Error("OKX: no balance data");
  const usdt    = d.details.find(x => x.ccy === "USDT");
  const availRaw = usdt?.availBal || usdt?.availEq || usdt?.cashBal || d.adjEq || "0";
  return {
    totalEquity:      parseFloat(d.totalEq  || "0"),
    availableBalance: parseFloat(availRaw),
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
