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
export interface BybitOrder   { orderId: string; symbol: string; side: string; qty: number; price: number; placedAt: string }
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
  const r = await get<{ list: Array<{ orderId: string; symbol: string; side: string; qty: string; price: string; createdTime: string }> }>(
    "/v5/order/realtime", { category: "linear" }
  ).catch(() => ({ list: [] as Array<{ orderId: string; symbol: string; side: string; qty: string; price: string; createdTime: string }> }));
  return r.list.map(o => ({ orderId: o.orderId, symbol: o.symbol, side: o.side, qty: parseFloat(o.qty), price: parseFloat(o.price), placedAt: new Date(parseInt(o.createdTime)).toISOString() }));
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

export async function openPosition(
  symbol: string,
  side: "Buy" | "Sell",
  amountUsd: number,
  leverage = 10,
  opts?: { stopLoss?: number; takeProfit?: number; tp1?: number },
): Promise<{ orderId: string; entryPrice: number; positionIdx: number; qty: number }> {
  // ── Position sizing ───────────────────────────────────────────────────────
  const { totalEquity, availableBalance } = await getBalance();
  const bybitBalance   = availableBalance;
  const riskAmount     = bybitBalance * 0.05;
  const minimumMargin  = 5;                    // Bybit minimum
  const maximumMargin  = bybitBalance * 0.30;

  const finalMargin = Math.max(
    minimumMargin,
    Math.min(riskAmount, maximumMargin),
  );

  console.log("Position sizing:", {
    riskAmount,
    minimumMargin,
    maximumMargin,
    finalMargin,
  });

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
  await setLeverage(sym, leverage);

  // Try to switch this symbol to hedge mode so longs and shorts can coexist.
  // positionIdx 1 = hedge-long (Buy), positionIdx 2 = hedge-short (Sell).
  // Falls back to positionIdx 0 (one-way) if the symbol already has an open position.
  const hedged     = await setHedgeModeForSymbol(sym);
  const positionIdx = hedged ? (side === "Buy" ? 1 : 2) : 0;

  const [ticker, filters] = await Promise.all([getTicker(sym), getInstrumentFilters(sym)]);
  const markPrice = ticker.lastPrice;
  const tickDp    = String(filters.tickSize).split(".")[1]?.length ?? 2;

  const rawQty  = amountUsd / markPrice;
  const steps   = Math.ceil(rawQty / filters.qtyStep);
  const qty     = Math.max(steps * filters.qtyStep, filters.minQty);
  const qtyStr  = qty.toFixed(String(filters.qtyStep).split(".")[1]?.length ?? 3);

  const orderValue = qty * markPrice;
  console.log(`[Bybit] Order:`, { symbol: sym, side, positionIdx, direction: side === "Buy" ? "long" : "short", qty: qtyStr, SL: opts?.stopLoss ?? "none", TP: opts?.takeProfit ?? "none", orderValue: orderValue.toFixed(2) });

  const orderBody: Record<string, unknown> = {
    category: "linear", symbol: sym, side,
    orderType: "Market", qty: qtyStr,
    timeInForce: "IOC", reduceOnly: false, positionIdx,
  };
  if (opts?.stopLoss)   orderBody["stopLoss"]   = (Math.round(opts.stopLoss   / filters.tickSize) * filters.tickSize).toFixed(tickDp);
  if (opts?.takeProfit) orderBody["takeProfit"] = (Math.round(opts.takeProfit / filters.tickSize) * filters.tickSize).toFixed(tickDp);

  const r = await bpost<{ orderId: string }>("/v5/order/create", orderBody);
  console.log(`[Bybit] Market ${side} ${sym} qty=${qtyStr} mark=$${markPrice.toFixed(2)} ${leverage}x posIdx=${positionIdx} SL=${opts?.stopLoss ?? "none"} TP=${opts?.takeProfit ?? "none"} TP1=${opts?.tp1 ?? "none"} → orderId=${r.orderId}`);

  // Set TP1 as exchange partial TP (30% of position) after order fills
  if (opts?.tp1 && opts.tp1 > 0) {
    const tp1Str    = (Math.round(opts.tp1 / filters.tickSize) * filters.tickSize).toFixed(tickDp);
    const tp1Qty    = (Math.floor(qty * 0.30 / filters.qtyStep) * filters.qtyStep);
    const tp1QtyStr = Math.max(tp1Qty, filters.minQty).toFixed(String(filters.qtyStep).split(".")[1]?.length ?? 3);

    // Wait for position to settle on Bybit before setting partial TP
    await new Promise(res => setTimeout(res, 600));

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

    // Verify TP1 partial order was accepted — query TP/SL orders separately from Full-mode position TP.
    // NOTE: livePos.takeProfit shows the Full-mode TP (TP2), not the TP1 partial order.
    if (tp1Set) {
      try {
        // Check TP/SL conditional orders for this symbol — TP1 partial appears here, not in position.takeProfit
        type TpslOrder = { triggerPrice: string; qty: string; reduceOnly: boolean };
        const tpslRes = await get<{ list: TpslOrder[] }>(
          "/v5/order/realtime", { category: "linear", symbol: sym, orderFilter: "tpslOrder" }
        ).catch(() => ({ list: [] as TpslOrder[] }));
        const tp1Order = tpslRes.list.find(o =>
          Math.abs(parseFloat(o.triggerPrice) / parseFloat(tp1Str) - 1) < 0.005
        );
        if (tp1Order) {
          console.log(`[Bybit] TP1 partial verified on exchange ${sym}: qty=${tp1Order.qty} at $${tp1Order.triggerPrice} (partial TP order)`);
        } else {
          console.warn(`[Bybit] TP1 partial order not found in exchange orders for ${sym} — software polling is fallback`);
          tp1Set = false;
        }
        // Separately log the Full-mode position TP (TP2) to distinguish the two
        const livePos = (await getPositions()).find(p => p.symbol === sym && p.positionIdx === positionIdx);
        if (livePos?.takeProfit) {
          console.log(`[Bybit] Position Full-mode TP (TP2) ${sym}: $${livePos.takeProfit}`);
        }
      } catch (e) {
        console.warn(`[Bybit] TP1 verification check ${sym}:`, (e as Error).message);
      }
    }

    if (!tp1Set) {
      console.error(`[Bybit] TP1 exchange order NOT set for ${sym} — software polling is the only fallback`);
    }
  }

  return { orderId: r.orderId, entryPrice: markPrice, positionIdx, qty };
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
  closedAt:      number; // epoch ms (updatedTime)
  openedAt:      number; // epoch ms (createdTime)
}

export async function getClosedPnl(limit = 20, startTime?: number, symbol?: string): Promise<BybitClosedPnl[]> {
  type Raw = { symbol: string; side: string; closedSize: string; avgEntryPrice: string; avgExitPrice: string; closedPnl: string; leverage: string; updatedTime: string; createdTime: string };
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
    closedAt:      parseInt(p.updatedTime),
    openedAt:      parseInt(p.createdTime),
  }));
}
