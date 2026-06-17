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

const RW = "10000";

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
export interface BybitPosition { symbol: string; side: "Buy" | "Sell" | "None"; size: number; entryPrice: number; markPrice: number; leverage: number; pnl: number; pnlPct: number; margin: number; stopLoss?: number; takeProfit?: number; liqPrice?: number; positionIdx: number; openTime: number }
export interface BybitOrder     { orderId: string; symbol: string; side: string; qty: number; price: number; placedAt: string; orderType?: string; sl?: number; tp?: number }
export interface BybitTpslOrder { symbol: string; stopOrderType: string; triggerPrice: number; qty: number; orderId: string }

// Registered by telegram.ts startPolling() so bybit.ts can alert without a circular import.
let _bybitAlertFn: ((msg: string) => Promise<void>) | null = null;
export function registerBybitAlertFn(fn: (msg: string) => Promise<void>): void { _bybitAlertFn = fn; }
export interface BybitBalance { totalEquity: number; availableBalance: number; usedMargin: number; currency: string }
export interface BybitKline   { ts: number; open: number; high: number; low: number; close: number; volume: number }

// ── Market ────────────────────────────────────────────────────────────────────
export async function getInstrumentFilters(symbol: string): Promise<{ minQty: number; qtyStep: number; tickSize: number }> {
  const r = await fetch(`${BASE_URL}/v5/market/instruments-info?category=linear&symbol=${symbol}`, { signal: AbortSignal.timeout(5000) });
  const j = await r.json() as { result?: { list?: Array<{ lotSizeFilter?: { minOrderQty?: string; qtyStep?: string }; priceFilter?: { tickSize?: string } }> } };
  const s = j.result?.list?.[0];
  return {
    minQty:   parseFloat(s?.lotSizeFilter?.minOrderQty  ?? "0.001"),
    qtyStep:  parseFloat(s?.lotSizeFilter?.qtyStep      ?? "0.001"),
    tickSize: parseFloat(s?.priceFilter?.tickSize       ?? "0.10"),
  };
}

export async function getTicker(symbol: string): Promise<BybitTicker> {
  const sym = normalise(symbol);
  const r   = await get<{ list: Array<{ symbol: string; lastPrice: string; bid1Price: string; ask1Price: string; price24hPcnt: string; markPrice: string }> }>(
    "/v5/market/tickers", { category: "linear", symbol: sym }
  );
  const d = r.list[0];
  if (!d) throw new Error(`Bybit: no ticker for ${sym}`);
  return { symbol: d.symbol, lastPrice: parseFloat(d.markPrice || d.lastPrice), bid: parseFloat(d.bid1Price), ask: parseFloat(d.ask1Price), change24h: parseFloat(d.price24hPcnt) * 100 };
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

export async function fetchKlines(params: {
  symbol: string; interval: string; end?: Date; start?: Date; limit?: number;
}): Promise<BybitKline[]> {
  const { symbol, interval, end, start, limit = 50 } = params;
  const query: Record<string, string | number> = {
    category: "linear", symbol: normalise(symbol), interval, limit,
  };
  if (end)   query["end"]   = end.getTime();
  if (start) query["start"] = start.getTime();
  const r = await get<{ list: string[][] }>("/v5/market/kline", query);
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
  type RawPos = { symbol: string; side: string; size: string; avgPrice: string; markPrice: string; leverage: string; unrealisedPnl: string; stopLoss: string; takeProfit: string; liqPrice: string; positionIdx: number; openTime?: string; createdTime?: string };
  const r = await get<{ list: RawPos[] }>("/v5/position/list", { category: "linear", settleCoin: "USDT" });
  console.log("[Bybit] Raw positions (settleCoin=USDT):", JSON.stringify(r.list));

  const list = r.list.filter(p => parseFloat(p.size) > 0);

  return list.map(p => {
    const entry    = parseFloat(p.avgPrice);
    const mark     = parseFloat(p.markPrice) || entry;
    const lev      = parseFloat(p.leverage);
    const size     = parseFloat(p.size);
    const pnl      = parseFloat(p.unrealisedPnl);
    const sl       = parseFloat(p.stopLoss)   || undefined;
    const tp       = parseFloat(p.takeProfit) || undefined;
    const liq      = parseFloat(p.liqPrice)   || undefined;
    const margin   = entry > 0 && lev > 0 ? (size * entry) / lev : 0;
    // pnlPct as % price move (direction-aware)
    const pnlPct   = p.side === "Buy"
      ? (mark - entry) / entry * 100
      : (entry - mark) / entry * 100;
    // openTime = actual position open time; createdTime is instrument/account creation (can be 2022)
    const openTime = parseInt(p.openTime ?? p.createdTime ?? "0");
    return { symbol: p.symbol, side: p.side as "Buy" | "Sell", size, entryPrice: entry, markPrice: mark, leverage: lev, pnl, pnlPct, margin, stopLoss: sl, takeProfit: tp, liqPrice: liq, positionIdx: p.positionIdx ?? 0, openTime };
  });
}

export async function getOrders(): Promise<BybitOrder[]> {
  const r = await get<{ list: Array<{ orderId: string; symbol: string; side: string; qty: string; price: string; createdTime: string; orderType?: string; stopLoss?: string; takeProfit?: string }> }>(
    "/v5/order/realtime", { category: "linear", orderFilter: "Order", settleCoin: "USDT" }
  ).catch(e => {
    console.error('[orders] getOrders failed:', (e as Error).message);
    throw e;
  });
  return r.list
    .filter(o => parseFloat(o.price) > 0) // exclude market/conditional orders (price=0)
    .map(o => ({
      orderId:   o.orderId,
      symbol:    o.symbol,
      side:      o.side,
      qty:       parseFloat(o.qty),
      price:     parseFloat(o.price),
      placedAt:  new Date(parseInt(o.createdTime)).toISOString(),
      orderType: o.orderType,
      sl:        o.stopLoss   ? parseFloat(o.stopLoss)   : undefined,
      tp:        o.takeProfit ? parseFloat(o.takeProfit) : undefined,
    }));
}

// Returns TP/SL conditional orders (PartialTakeProfit, TakeProfit, StopLoss, PartialStopLoss).
// IMPORTANT: orderFilter="StopOrder" is required — PartialTakeProfit conditionals placed via
// /v5/position/trading-stop live here. orderFilter="tpslOrder" returns empty for these orders.
export async function getTpslOrders(symbol?: string): Promise<BybitTpslOrder[]> {
  const params: Record<string, string> = { category: "linear", orderFilter: "StopOrder", settleCoin: "USDT" };
  if (symbol) params["symbol"] = normalise(symbol);
  const r = await get<{ list: Array<{ symbol: string; stopOrderType?: string; triggerPrice?: string; qty?: string; orderId: string }> }>(
    "/v5/order/realtime", params
  ).catch(e => {
    console.error("[orders] getTpslOrders failed:", (e as Error).message);
    return { list: [] as Array<{ symbol: string; stopOrderType?: string; triggerPrice?: string; qty?: string; orderId: string }> };
  });
  return r.list.map(o => ({
    symbol:        o.symbol,
    stopOrderType: o.stopOrderType ?? "",
    triggerPrice:  parseFloat(o.triggerPrice || "0"),
    qty:           parseFloat(o.qty || "0"),
    orderId:       o.orderId,
  }));
}

// ── Idempotent partial conditional order placement ────────────────────────────
// Root fix for per-site idempotency gaps: all PartialTakeProfit/PartialStopLoss placements
// route through this function instead of calling setTp1Partial/setTp2Partial directly.
//
// Guarantees:
//   1. FAIL-CLOSED: if the exchange check fails (API down/timeout), the order is NOT placed
//      and an alert fires — never place blind on an uncertain exchange state.
//   2. IDEMPOTENT: matches existing orders by type AND price (±0.1%) so TP1 and TP2 partials
//      at different prices don't confuse each other.
//   3. CORRECT ENDPOINT: uses orderFilter=StopOrder (where PartialTakeProfit lives), not
//      orderFilter=tpslOrder (which returns empty for these orders).
//
// CALLERS own business-logic pre-checks (tp1Executed, size-shrink, closePercent < 100).
// This function owns only the exchange-state check and idempotent placement.
//
// qty parameter = current position size (not order size); setTp1Partial computes partial qty.
export type EnsurePartialResult = "placed" | "skipped-exists" | "skipped-error";

export async function ensurePartialOrder(
  symbol:       string,
  type:         "PartialTakeProfit" | "PartialStopLoss",
  price:        number,
  qty:          number,
  positionIdx:  number,
  closePercent  = 30,
): Promise<EnsurePartialResult> {
  const sym = normalise(symbol);
  const pfx = `[ensurePartialOrder] ${sym} ${type} $${price.toFixed(4)}`;

  // Step 1: query exchange via raw get — getTpslOrders silently returns [] on error,
  // so we call get() directly to distinguish API failure from a genuinely empty list.
  type RawOrder = { symbol: string; stopOrderType?: string; triggerPrice?: string; qty?: string; orderId: string };
  let orders: RawOrder[];
  try {
    const r = await get<{ list: RawOrder[] }>(
      "/v5/order/realtime",
      { category: "linear", orderFilter: "StopOrder", symbol: sym, settleCoin: "USDT" }
    );
    orders = r.list;
  } catch (e) {
    console.error(`${pfx}: exchange check FAILED —`, (e as Error).message);
    await _bybitAlertFn?.(`⚠️ ${sym}: ${type} exchange check failed — NOT placed, verify manually`).catch(() => {});
    return "skipped-error";
  }

  // Step 2: match by type AND price within 0.1% — price matching is required so a live
  // TP1 at $209.2 does not cause the TP2 guard at $203 to return skipped-exists.
  const PRICE_TOL = 0.001;
  const found = orders.find(
    o => (o.stopOrderType ?? "") === type &&
      Math.abs(parseFloat(o.triggerPrice ?? "0") - price) / price < PRICE_TOL
  );
  if (found) {
    console.log(`${pfx}: skipped — exists on exchange (id=...${found.orderId.slice(-8)})`);
    return "skipped-exists";
  }

  // Step 3: place — setTp1Partial handles retry (3 attempts) and its own alert on failure.
  // Both TP1 and TP2 partials are PartialTakeProfit on Bybit; the distinction is the price.
  console.log(`${pfx}: placing (posQty=${qty} closePercent=${closePercent})`);
  const placed = await setTp1Partial(sym, price, positionIdx, qty, closePercent);
  return placed ? "placed" : "skipped-error";
}

export async function cancelOrder(symbol: string, orderId: string): Promise<void> {
  const sym = normalise(symbol);
  await bpost("/v5/order/cancel", { category: "linear", symbol: sym, orderId });
  console.log(`[Bybit] Cancelled order ${orderId} for ${sym}`);
}

export async function getBalance(): Promise<BybitBalance> {
  const r = await get<{ list: Array<{ totalEquity: string; totalAvailableBalance: string; totalInitialMargin: string }> }>(
    "/v5/account/wallet-balance", { accountType: "UNIFIED" }
  );
  const d = r.list[0];
  if (!d) throw new Error("Bybit: no balance data");
  const equity    = parseFloat(d.totalEquity)             || 0;
  const available = parseFloat(d.totalAvailableBalance)   || equity;
  const usedMargin = parseFloat(d.totalInitialMargin)     || Math.max(0, equity - available);
  return { totalEquity: equity, availableBalance: available, usedMargin, currency: "USDT" };
}

// ── Trading ───────────────────────────────────────────────────────────────────

// Try to switch a single symbol to hedge mode (mode=3, positionIdx 1=long / 2=short).
// Silently ignores failure — symbol may already be in hedge mode or have open positions
// that prevent switching (those stay on positionIdx=0 one-way).
async function setHedgeModeForSymbol(symbol: string): Promise<boolean> {
  try {
    await bpost("/v5/position/switch-mode", { category: "linear", symbol, mode: 3 });
    return true;
  } catch (e: any) {
    // 110025 = already in the requested mode
    if (e.message?.includes("110025")) return true;
    // anything else (e.g. open position exists) → fall back to one-way
    return false;
  }
}

// Kept for backward-compat import in startup.ts — now a no-op (hedge mode is set per-symbol)
export async function setOneWayMode(): Promise<void> { return; }

export async function setLeverage(symbol: string, leverage: number): Promise<void> {
  const sym = normalise(symbol);
  await bpost("/v5/position/set-leverage", { category: "linear", symbol: sym, buyLeverage: String(leverage), sellLeverage: String(leverage) })
    .catch(e => { if (!e.message.includes("110043")) throw e; }); // 110043 = leverage not modified
}

export async function setTp1Partial(symbol: string, tp1Price: number, positionIdx: number, posQty: number, tp1ClosePercent = 30): Promise<boolean> {
  const sym     = normalise(symbol);
  const filters = await getInstrumentFilters(sym).catch(() => null);
  if (!filters) return false;
  const tickDp    = String(filters.tickSize).split(".")[1]?.length ?? 2;
  const tp1Str    = (Math.round(tp1Price / filters.tickSize) * filters.tickSize).toFixed(tickDp);
  const tp1Qty    = Math.floor(posQty * (tp1ClosePercent / 100) / filters.qtyStep) * filters.qtyStep;
  const tp1QtyStr = Math.max(tp1Qty, filters.minQty).toFixed(String(filters.qtyStep).split(".")[1]?.length ?? 3);
  let tp1Set = false;
  for (let attempt = 1; attempt <= 3 && !tp1Set; attempt++) {
    try {
      await bpost("/v5/position/trading-stop", {
        category: "linear", symbol: sym,
        takeProfit: tp1Str, tpSize: tp1QtyStr,
        tpTriggerBy: "LastPrice", tpslMode: "Partial",
        positionIdx,
      });
      tp1Set = true;
      console.log(`[Bybit] TP1 partial set ${sym}: 30% (${tp1QtyStr}) at $${tp1Str}`);
    } catch (e) {
      console.warn(`[Bybit] TP1 partial set ${sym} attempt ${attempt}/3:`, (e as Error).message);
      if (attempt < 3) await new Promise(res => setTimeout(res, 1000));
    }
  }
  if (!tp1Set) {
    console.error(`[Bybit] TP1 exchange order NOT set for ${sym} — software polling is the only fallback`);
    _bybitAlertFn?.(`⚠️ ${sym}: TP1 PartialTakeProfit NOT live on Bybit (expected $${tp1Str}) — placement failed after 3 attempts, verify/replace manually`).catch(() => {});
  }
  return tp1Set;
}

export async function setTp2Partial(symbol: string, tp2Price: number, positionIdx: number, posQty: number, tp2ClosePercent = 100): Promise<void> {
  const sym = normalise(symbol);
  if (tp2ClosePercent >= 100) {
    await setTakeProfit(sym, tp2Price, positionIdx);
    return;
  }
  const filters = await getInstrumentFilters(sym).catch(() => null);
  if (!filters) return;
  const tickDp    = String(filters.tickSize).split(".")[1]?.length ?? 2;
  const tp2Str    = (Math.round(tp2Price / filters.tickSize) * filters.tickSize).toFixed(tickDp);
  const tp2Qty    = Math.floor(posQty * (tp2ClosePercent / 100) / filters.qtyStep) * filters.qtyStep;
  const tp2QtyStr = Math.max(tp2Qty, filters.minQty).toFixed(String(filters.qtyStep).split(".")[1]?.length ?? 3);
  await bpost("/v5/position/trading-stop", {
    category: "linear", symbol: sym,
    takeProfit: tp2Str, tpSize: tp2QtyStr,
    tpTriggerBy: "LastPrice", tpslMode: "Partial",
    positionIdx,
  }).catch(e => console.warn(`[Bybit] TP2 partial set ${sym}:`, (e as Error).message));
  console.log(`[Bybit] TP2 partial set ${sym}: ${tp2ClosePercent}% (${tp2QtyStr}) at $${tp2Str}`);
}

export async function openPosition(
  symbol: string,
  side: "Buy" | "Sell",
  amountUsd: number,
  leverage = 10,
  opts?: { stopLoss?: number; takeProfit?: number; tp1?: number; limitPrice?: number; tp1ClosePercent?: number; tp2ClosePercent?: number },
): Promise<{ orderId: string; entryPrice: number; positionIdx: number; qty: number; isLimitOrder: boolean; actualMarginUsd: number }> {
  // ── Leverage cap ─────────────────────────────────────────────────────────
  const MAX_LEVERAGE = 10;
  if (leverage > MAX_LEVERAGE) {
    console.log(`[Bybit] Leverage capped: ${leverage}x → ${MAX_LEVERAGE}x (safety cap)`);
    leverage = MAX_LEVERAGE;
  }

  // ── Position sizing ───────────────────────────────────────────────────────
  const { totalEquity, availableBalance } = await getBalance();
  const bybitBalance   = availableBalance;
  const minimumMargin  = 5;                    // Bybit minimum
  const maximumMargin  = bybitBalance * 0.30;

  // amountUsd arrives as notional; derive requested margin then apply limits
  const requestedMargin = amountUsd / leverage;
  const clampedMargin   = Math.max(minimumMargin, Math.min(requestedMargin, maximumMargin));
  if (clampedMargin !== requestedMargin) {
    console.warn(`[Bybit] Margin clamped: requested $${requestedMargin.toFixed(2)} → $${clampedMargin.toFixed(2)}`);
  }
  amountUsd = clampedMargin * leverage;   // convert back to notional

  if (amountUsd < 5) {
    throw new Error(
      `❌ Insufficient available margin\nAvailable: $${availableBalance.toFixed(2)} (30% cap = $${maximumMargin.toFixed(2)}) | Minimum notional: $5`,
    );
  }

  const sym = normalise(symbol);

  // Set leverage only if it differs from current position leverage (avoids unnecessary API calls)
  const livePositions = await getPositions().catch(() => [] as BybitPosition[]);
  const existingPos   = livePositions.find(p => normalise(p.symbol) === sym);
  if (!existingPos || existingPos.leverage !== leverage) {
    await setLeverage(sym, leverage);
  } else {
    console.log(`[Bybit] ${sym} leverage already ${leverage}x — skipping set-leverage`);
  }

  // Try to switch this symbol to hedge mode so longs and shorts can coexist.
  // positionIdx 1 = hedge-long (Buy), positionIdx 2 = hedge-short (Sell).
  // Falls back to positionIdx 0 (one-way) if the symbol already has an open position.
  const hedged     = await setHedgeModeForSymbol(sym);
  const positionIdx = hedged ? (side === "Buy" ? 1 : 2) : 0;

  const [ticker, filters] = await Promise.all([getTicker(sym), getInstrumentFilters(sym)]);
  const markPrice = ticker.lastPrice;
  const tickDp    = String(filters.tickSize).split(".")[1]?.length ?? 2;

  const qtyDp    = String(filters.qtyStep).split(".")[1]?.length ?? 3;
  const rawQty   = amountUsd / markPrice;
  const steps    = Math.floor(rawQty / filters.qtyStep);          // floor: never over-deploy
  let   qty      = Math.max(steps * filters.qtyStep, filters.minQty);
  // Re-check margin cap after rounding — minQty guard can push over cap
  if (qty * markPrice / leverage > maximumMargin) {
    const reduced = parseFloat((qty - filters.qtyStep).toFixed(qtyDp));
    if (reduced >= filters.minQty) {
      qty = reduced;
    } else {
      throw new Error(`[sizing-skip] ${sym}: minQty margin ($${(filters.minQty * markPrice / leverage).toFixed(2)}) exceeds 30% cap ($${maximumMargin.toFixed(2)}) — balance too low`);
    }
  }
  const qtyStr  = qty.toFixed(qtyDp);

  // Use limit order if Claude provided limitPrice within 2% of current mark price
  const lp          = opts?.limitPrice;
  const priceDiff   = lp ? Math.abs(lp - markPrice) / markPrice : 1;
  const useLimit    = lp && lp > 0 && priceDiff <= 0.02;
  const execPrice   = useLimit ? lp : markPrice;

  // Recalculate qty at limit price so notional is correct
  const limitRawQty  = useLimit ? (amountUsd / execPrice!) : rawQty;
  const limitSteps   = Math.floor(limitRawQty / filters.qtyStep); // floor: never over-deploy
  let   limitQty     = Math.max(limitSteps * filters.qtyStep, filters.minQty);
  if (useLimit && limitQty * execPrice! / leverage > maximumMargin) {
    const reduced = parseFloat((limitQty - filters.qtyStep).toFixed(qtyDp));
    if (reduced >= filters.minQty) limitQty = reduced;
  }
  const limitQtyStr  = limitQty.toFixed(qtyDp);
  const finalQtyStr  = useLimit ? limitQtyStr : qtyStr;

  const orderValue = (useLimit ? limitQty : qty) * (useLimit ? execPrice! : markPrice);
  console.log(`[Bybit] Order:`, { symbol: sym, side, positionIdx, direction: side === "Buy" ? "long" : "short", qty: finalQtyStr, SL: opts?.stopLoss ?? "none", TP: opts?.takeProfit ?? "none", orderValue: orderValue.toFixed(2), margin: (orderValue / leverage).toFixed(2) });

  const limitPxStr   = useLimit ? (Math.round(execPrice! / filters.tickSize) * filters.tickSize).toFixed(tickDp) : undefined;

  const orderBody: Record<string, unknown> = {
    category: "linear", symbol: sym, side,
    orderType:   useLimit ? "Limit" : "Market",
    qty:         finalQtyStr,
    timeInForce: useLimit ? "GTC" : "IOC",
    reduceOnly: false, positionIdx,
    ...(useLimit ? { price: limitPxStr } : {}),
  };
  if (opts?.stopLoss) orderBody["stopLoss"] = (Math.round(opts.stopLoss / filters.tickSize) * filters.tickSize).toFixed(tickDp);
  // Only set Full-mode TP on order body when tp2ClosePercent = 100 (default).
  // For partial TP2, skip order body — setTp2Partial called after fill instead.
  if (opts?.takeProfit && (opts.tp2ClosePercent ?? 100) >= 100) {
    orderBody["takeProfit"] = (Math.round(opts.takeProfit / filters.tickSize) * filters.tickSize).toFixed(tickDp);
  }

  const r = await bpost<{ orderId: string }>("/v5/order/create", orderBody);
  if (useLimit) {
    console.log(`[Bybit] Limit ${side} ${sym} qty=${finalQtyStr} @$${limitPxStr} (mark=$${markPrice.toFixed(2)}, diff=${(priceDiff*100).toFixed(2)}%) ${leverage}x posIdx=${positionIdx} SL=${opts?.stopLoss ?? "none"} TP=${opts?.takeProfit ?? "none"} → orderId=${r.orderId}`);
  } else {
    const reason = lp ? `limitPrice $${lp} too far from mark $${markPrice.toFixed(2)} (${(priceDiff*100).toFixed(2)}%) — ` : "";
    console.log(`[Bybit] Market ${side} ${sym} qty=${finalQtyStr} mark=$${markPrice.toFixed(2)} ${leverage}x posIdx=${positionIdx} ${reason}SL=${opts?.stopLoss ?? "none"} TP=${opts?.takeProfit ?? "none"} TP1=${opts?.tp1 ?? "none"} → orderId=${r.orderId}`);
  }

  // For market orders only: set TP1/TP2 partials immediately (position exists).
  // Limit orders defer to posMonitor fill detection — position doesn't exist yet.
  if (!useLimit) {
    await new Promise(res => setTimeout(res, 600)); // let position settle
    if (opts?.tp1 && opts.tp1 > 0) {
      await setTp1Partial(sym, opts.tp1, positionIdx, qty, opts.tp1ClosePercent);
    }
    if (opts?.takeProfit && opts.takeProfit > 0 && (opts.tp2ClosePercent ?? 100) < 100) {
      await setTp2Partial(sym, opts.takeProfit, positionIdx, qty, opts.tp2ClosePercent!);
    }
  }

  const finalQty        = useLimit ? limitQty : qty;
  const finalExecPrice  = useLimit ? execPrice! : markPrice;
  const actualMarginUsd = finalQty * finalExecPrice / leverage;
  return { orderId: r.orderId, entryPrice: finalExecPrice, positionIdx, qty: finalQty, isLimitOrder: !!useLimit, actualMarginUsd };
}

export async function closePosition(symbol: string): Promise<{ orderId: string; entryPrice: number; size: number; side: "Buy" | "Sell" }> {
  const sym       = normalise(symbol);
  const positions = await getPositions();
  const pos       = positions.find(p => p.symbol === sym);
  if (!pos || pos.size <= 0) throw new Error(`Bybit: no open position for ${sym}`);
  const closeSide = pos.side === "Buy" ? "Sell" : "Buy";
  const r = await bpost<{ orderId: string }>("/v5/order/create", { category: "linear", symbol: sym, side: closeSide, orderType: "Market", qty: String(pos.size), reduceOnly: true, positionIdx: pos.positionIdx });
  console.log(`[Bybit] Close ${sym} qty=${pos.size} posIdx=${pos.positionIdx} orderId=${r.orderId}`);
  return { orderId: r.orderId, entryPrice: pos.entryPrice, size: pos.size, side: pos.side as "Buy" | "Sell" };
}

export async function setTrailingStop(symbol: string, trailingPct = 0.40): Promise<void> {
  const sym       = normalise(symbol);
  const positions = await getPositions().catch(() => [] as BybitPosition[]);
  const pos       = positions.find(p => p.symbol === sym);
  const posIdx    = pos?.positionIdx ?? 0;
  const ticker    = await getTicker(sym).catch(() => null);
  if (!ticker) return;
  const trail  = (ticker.lastPrice * trailingPct).toFixed(2);
  await bpost("/v5/position/trading-stop", { category: "linear", symbol: sym, trailingStop: trail, positionIdx: posIdx })
    .catch(e => console.warn(`[Bybit] setTrailingStop ${sym}: ${e.message}`));
  console.log(`[Bybit] Trailing stop ${trailingPct * 100}% on ${sym} posIdx=${posIdx} ≈ $${trail}`);
}

export async function setStopLoss(symbol: string, stopLossPrice: number, positionIdx = 0): Promise<void> {
  const sym = normalise(symbol);
  await bpost("/v5/position/trading-stop", { category: "linear", symbol: sym, stopLoss: String(stopLossPrice), positionIdx })
    .catch(e => console.warn(`[Bybit] setStopLoss ${sym}: ${e.message}`));
}

export async function setTakeProfit(symbol: string, takeProfitPrice: number, positionIdx = 0): Promise<void> {
  const sym = normalise(symbol);
  await bpost("/v5/position/trading-stop", { category: "linear", symbol: sym, takeProfit: String(takeProfitPrice), positionIdx })
    .catch(e => console.warn(`[Bybit] setTakeProfit ${sym}: ${e.message}`));
}

// ── Market data ───────────────────────────────────────────────────────────────
export async function getFundingRate(symbol: string): Promise<{ rate: number; nextFundingTime: number }> {
  const sym = normalise(symbol);
  // tickers endpoint includes current funding rate and next funding time
  const r = await get<{ list: Array<{ fundingRate: string; nextFundingTime: string }> }>(
    "/v5/market/tickers", { category: "linear", symbol: sym }
  ).catch(() => ({ list: [] as Array<{ fundingRate: string; nextFundingTime: string }> }));
  const d = r.list[0];
  return {
    rate:            parseFloat(d?.fundingRate     ?? "0") || 0,
    nextFundingTime: parseInt(d?.nextFundingTime   ?? "0") || 0,
  };
}

export async function getOpenInterest(symbol: string): Promise<number> {
  const sym = normalise(symbol);
  const r = await get<{ list: Array<{ openInterest: string; timestamp: string }> }>(
    "/v5/market/open-interest", { category: "linear", symbol: sym, intervalTime: "1h", limit: 1 }
  ).catch(() => ({ list: [] as Array<{ openInterest: string; timestamp: string }> }));
  return parseFloat(r.list[0]?.openInterest ?? "0") || 0;
}

export async function getOrderbook(symbol: string, limit = 50): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> }> {
  const sym = normalise(symbol);
  const r = await get<{ b: string[][]; a: string[][] }>(
    "/v5/market/orderbook", { category: "linear", symbol: sym, limit }
  ).catch(() => ({ b: [] as string[][], a: [] as string[][] }));
  return {
    bids: r.b.map(([p, s]) => [parseFloat(p), parseFloat(s)] as [number, number]),
    asks: r.a.map(([p, s]) => [parseFloat(p), parseFloat(s)] as [number, number]),
  };
}

export async function getFundingHistory(symbol: string, limit = 24): Promise<number[]> {
  const sym = normalise(symbol);
  const r = await get<{ list: Array<{ fundingRate: string }> }>(
    "/v5/market/funding/history", { category: "linear", symbol: sym, limit }
  ).catch(() => ({ list: [] as Array<{ fundingRate: string }> }));
  // list is newest-first; reverse to oldest→newest
  return r.list.map(e => parseFloat(e.fundingRate) || 0).reverse();
}

// ── Limit order (GTC) ─────────────────────────────────────────────────────────
export async function openLimitPosition(symbol: string, side: "Buy" | "Sell", amountUsd: number, limitPrice: number, leverage = 10): Promise<{ orderId: string }> {
  if (amountUsd < 5) throw new Error(`Bybit: order amount $${amountUsd} below $5 minimum`);
  const sym     = normalise(symbol);
  await setLeverage(sym, leverage);
  const filters = await getInstrumentFilters(sym);

  const rawQty  = amountUsd / limitPrice;
  const steps   = Math.ceil(rawQty / filters.qtyStep);
  const qty     = Math.max(steps * filters.qtyStep, filters.minQty);
  const qtyStr  = qty.toFixed(String(filters.qtyStep).split(".")[1]?.length ?? 3);
  const tickDp  = String(filters.tickSize).split(".")[1]?.length ?? 2;
  const px      = (Math.round(limitPrice / filters.tickSize) * filters.tickSize).toFixed(tickDp);

  const r = await bpost<{ orderId: string }>("/v5/order/create", {
    category: "linear", symbol: sym, side,
    orderType: "Limit", price: px, qty: qtyStr,
    timeInForce: "GTC", reduceOnly: false,
  });
  console.log(`[Bybit] LimitGTC ${side} ${sym} qty=${qtyStr} @$${px} ${leverage}x → orderId=${r.orderId}`);
  return { orderId: r.orderId };
}

// ── Partial close ─────────────────────────────────────────────────────────────
export async function closePartialByAmount(symbol: string, amountUsd: number): Promise<{ orderId: string }> {
  const sym       = normalise(symbol);
  const positions = await getPositions();
  const pos       = positions.find(p => p.symbol === sym);
  if (!pos || pos.size <= 0) throw new Error(`Bybit: no open position for ${sym}`);

  const closeSide = pos.side === "Buy" ? "Sell" : "Buy";
  const ticker    = await getTicker(sym);
  const filters   = await getInstrumentFilters(sym);
  const rawQty    = amountUsd / ticker.lastPrice;
  const steps     = Math.floor(rawQty / filters.qtyStep);
  const qty       = Math.min(Math.max(steps * filters.qtyStep, filters.minQty), pos.size);
  const qtyStr    = qty.toFixed(String(filters.qtyStep).split(".")[1]?.length ?? 3);

  const r = await bpost<{ orderId: string }>("/v5/order/create", {
    category: "linear", symbol: sym, side: closeSide,
    orderType: "Market", qty: qtyStr, reduceOnly: true, positionIdx: pos.positionIdx,
  });
  console.log(`[Bybit] Partial close ${sym} ~$${amountUsd} qty=${qtyStr} posIdx=${pos.positionIdx} orderId=${r.orderId}`);
  return { orderId: r.orderId };
}

export async function closePercentPosition(symbol: string, pct: number): Promise<{ orderId: string }> {
  const sym       = normalise(symbol);
  const positions = await getPositions();
  const pos       = positions.find(p => p.symbol === sym);
  if (!pos || pos.size <= 0) throw new Error(`Bybit: no open position for ${sym}`);

  const closeSide = pos.side === "Buy" ? "Sell" : "Buy";
  const filters   = await getInstrumentFilters(sym);
  const rawQty    = pos.size * (pct / 100);
  const steps     = Math.floor(rawQty / filters.qtyStep);
  const qty       = Math.max(steps * filters.qtyStep, filters.minQty);
  const qtyStr    = qty.toFixed(String(filters.qtyStep).split(".")[1]?.length ?? 3);

  const r = await bpost<{ orderId: string }>("/v5/order/create", {
    category: "linear", symbol: sym, side: closeSide,
    orderType: "Market", qty: qtyStr, reduceOnly: true, positionIdx: pos.positionIdx,
  });
  console.log(`[Bybit] Close ${pct}% of ${sym} qty=${qtyStr} posIdx=${pos.positionIdx} orderId=${r.orderId}`);
  return { orderId: r.orderId };
}

// ── Backward-compat wrapper ───────────────────────────────────────────────────
export async function placeOrder(symbol: string, side: "Buy" | "Sell", amountUsd: number): Promise<{ orderId?: string }> {
  return openPosition(symbol, side, amountUsd, 1);
}

export interface BybitClosedPnl {
  symbol:        string;
  side:          "Buy" | "Sell";
  closedSize:    number;
  avgEntryPrice: number;
  avgExitPrice:  number;
  closedPnl:     number;
  leverage:      number;
  orderId:              string;
  closedAt:             number; // epoch ms (updatedTime) — when this close executed
  closeOrderCreatedAt:  number; // epoch ms (createdTime) — when this close ORDER was placed (not position open time)
}

export async function getClosedPnl(limit = 20, startTime?: number, symbol?: string): Promise<BybitClosedPnl[]> {
  type Raw = { symbol: string; side: string; closedSize: string; avgEntryPrice: string; avgExitPrice: string; closedPnl: string; leverage: string; updatedTime: string; createdTime: string; orderId: string };
  const params: Record<string, string> = { category: "linear", limit: String(limit) };
  if (startTime !== undefined) params.startTime = String(startTime);
  if (symbol   !== undefined) params.symbol    = symbol;
  const r = await get<{ list: Raw[] }>("/v5/position/closed-pnl", params);
  return r.list.map(p => ({
    symbol:        p.symbol,
    side:          p.side as "Buy" | "Sell",
    closedSize:    parseFloat(p.closedSize),
    avgEntryPrice: parseFloat(p.avgEntryPrice),
    avgExitPrice:  parseFloat(p.avgExitPrice),
    closedPnl:     parseFloat(p.closedPnl),
    leverage:      parseFloat(p.leverage),
    orderId:              p.orderId,
    closedAt:             parseInt(p.updatedTime),
    closeOrderCreatedAt:  parseInt(p.createdTime),
  }));
}

// Looks up stopOrderType for a single close orderId — used to distinguish exchange-triggered
// SL/TP from bot software closes and manual human closes. Bybit retains order history for 2 years.
export async function getOrderStopType(symbol: string, orderId: string): Promise<string> {
  type Raw = { stopOrderType?: string };
  const params: Record<string, string> = { category: "linear", symbol: normalise(symbol), orderId };
  const r = await get<{ list: Raw[] }>("/v5/order/history", params);
  return r.list[0]?.stopOrderType ?? "";
}
