import { randomUUID } from "crypto";

const BASE = "https://public-api.etoro.com/api/v1";
const ENV  = process.env["ETORO_ENV"] === "demo" ? "demo" : "real";

function getHeaders(): Record<string, string> {
  const apiKey  = process.env["ETORO_PUBLIC_KEY"];
  const userKey = process.env["ETORO_USER_KEY"];
  if (!apiKey || !userKey) {
    throw new Error("ETORO_PUBLIC_KEY and ETORO_USER_KEY env vars are required");
  }
  return {
    "Content-Type": "application/json",
    "x-api-key":    apiKey,
    "x-user-key":   userKey,
    "x-request-id": randomUUID(),
  };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: getHeaders(),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`eToro ${method} ${path} → HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// Forward cache: symbol → instrumentId
const instrumentCache = new Map<string, number>();
// Reverse cache: instrumentId → symbol
const reverseCache    = new Map<number, string>();

async function resolveInstrumentId(symbol: string): Promise<number> {
  const key = symbol.toUpperCase();
  if (instrumentCache.has(key)) return instrumentCache.get(key)!;
  const data = await request<{ items?: Array<{ instrumentId?: number; internalInstrumentId?: number; internalSymbolFull: string }> }>(
    "GET", `/market-data/search?internalSymbolFull=${encodeURIComponent(key)}&pageSize=1`
  );
  const match = data.items?.[0];
  if (!match) throw new Error(`eToro: instrument not found for symbol "${symbol}"`);
  const id = match.instrumentId ?? match.internalInstrumentId ?? 0;
  instrumentCache.set(key, id);
  reverseCache.set(id, match.internalSymbolFull.toUpperCase());
  return id;
}

async function resolveSymbolFromId(instrumentId: number): Promise<string> {
  if (reverseCache.has(instrumentId)) return reverseCache.get(instrumentId)!;
  try {
    const data = await request<{ items?: Array<{ internalSymbolFull?: string; internalInstrumentId?: number }> }>(
      "GET", `/market-data/search?instrumentId=${instrumentId}&pageSize=1`
    );
    const sym = data.items?.[0]?.internalSymbolFull?.toUpperCase() ?? String(instrumentId);
    reverseCache.set(instrumentId, sym);
    if (sym !== String(instrumentId)) instrumentCache.set(sym, instrumentId);
    return sym;
  } catch {
    return String(instrumentId);
  }
}

export interface EtoroPosition {
  positionId: string;
  instrumentId: number;
  symbol:     string;
  amountUsd:  number;
  profit:     number;
  units:      number;
  openRate:   number;
  isBuy:      boolean;
}

export async function getPositionsWithSymbols(): Promise<EtoroPosition[]> {
  const raw = (await getPortfolio()) as {
    clientPortfolio?: { positions?: Array<Record<string, unknown>> };
    positions?:       Array<Record<string, unknown>>;
  };
  const positions = raw?.clientPortfolio?.positions ?? raw?.positions ?? [];
  if (!positions.length) return [];

  // Batch-resolve unique instrumentIDs in parallel
  const uniqueIds = [...new Set(positions.map(p => Number(p["instrumentID"] ?? p["instrumentId"] ?? 0)).filter(Boolean))];
  await Promise.all(uniqueIds.map(id => resolveSymbolFromId(id).catch(() => {})));

  return positions.map(p => {
    const instId = Number(p["instrumentID"] ?? p["instrumentId"] ?? 0);
    const sym    = reverseCache.get(instId) ?? String(instId);
    return {
      positionId:   String(p["positionID"] ?? p["positionId"] ?? ""),
      instrumentId: instId,
      symbol:       sym,
      amountUsd:    Number(p["amount"]          ?? p["Amount"]          ?? 0),
      profit:       Number(p["profit"]          ?? p["Profit"]          ?? p["totalProfit"] ?? 0),
      units:        Number(p["units"]           ?? p["Units"]           ?? 0),
      openRate:     Number(p["openRate"]        ?? p["OpenRate"]        ?? 0),
      isBuy:        (p["isBuy"] ?? true) !== false,
    };
  });
}

export async function openPosition(
  symbol: string,
  amountUsd: number,
  isBuy: boolean,
): Promise<{ positionId: string }> {
  const instrumentId = await resolveInstrumentId(symbol);
  const result = await request<{ orderForOpen?: { orderID?: number }; token?: string }>(
    "POST",
    `/trading/execution/${ENV}/market-open-orders/by-amount`,
    { InstrumentId: instrumentId, IsBuy: isBuy, Leverage: 1, Amount: amountUsd },
  );
  const orderId = result.orderForOpen?.orderID ?? 0;
  return { positionId: String(orderId) };
}

export async function closePosition(positionId: string): Promise<void> {
  await request<unknown>(
    "POST",
    `/trading/execution/${ENV}/market-close-orders/positions/${positionId}`,
    { UnitsToDeduct: null },
  );
}

export async function getPortfolio(): Promise<unknown> {
  return request<unknown>("GET", `/trading/info/${ENV}/portfolio`);
}

export interface PendingEtoroOrder {
  orderId:   string;
  symbol:    string;
  side:      "buy" | "sell";
  amountUsd: number;
  placedAt?: string;
}

export async function getLiveRates(instrumentIds: number[]): Promise<Map<number, number>> {
  if (!instrumentIds.length) return new Map();
  const data = await request<{
    rates?: Array<{ instrumentID: number; lastExecution?: number; ask?: number; bid?: number }>;
  }>("GET", `/market-data/instruments/rates?instrumentIds=${instrumentIds.join(",")}`);
  return new Map(
    (data.rates ?? []).map(r => [
      r.instrumentID,
      r.lastExecution ?? ((r.ask ?? 0) + (r.bid ?? 0)) / 2,
    ]),
  );
}

export async function getOrders(): Promise<PendingEtoroOrder[]> {
  try {
    const raw = await request<{
      clientPortfolio?: {
        ordersForOpen?: Array<{
          orderID?:     number;
          instrumentID?: number;
          amount?:      number;
          isBuy?:       boolean;
          openDateTime?: string;
        }>;
      };
    }>("GET", `/trading/info/${ENV}/portfolio`);

    const items = raw?.clientPortfolio?.ordersForOpen ?? [];
    if (!items.length) return [];

    // Resolve all unique instrumentIDs to symbols in parallel
    const uniqueIds = [...new Set(items.map(o => o.instrumentID ?? 0).filter(Boolean))];
    await Promise.all(uniqueIds.map(id => resolveSymbolFromId(id).catch(() => {})));

    return items.map(o => {
      const instId = o.instrumentID ?? 0;
      const sym    = reverseCache.get(instId) ?? String(instId);
      return {
        orderId:   String(o.orderID ?? ""),
        symbol:    sym,
        side:      o.isBuy !== false ? "buy" : "sell",
        amountUsd: o.amount ?? 0,
        placedAt:  o.openDateTime,
      };
    });
  } catch {
    return [];
  }
}
