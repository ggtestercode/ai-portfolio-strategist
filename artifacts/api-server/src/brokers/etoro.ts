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

const instrumentCache = new Map<string, number>();
async function resolveInstrumentId(symbol: string): Promise<number> {
  const key = symbol.toUpperCase();
  if (instrumentCache.has(key)) return instrumentCache.get(key)!;
  const data = await request<{ items?: Array<{ instrumentId: number; internalSymbolFull: string }> }>(
    "GET", `/market-data/search?internalSymbolFull=${encodeURIComponent(key)}&pageSize=1`
  );
  const match = data.items?.[0];
  if (!match) throw new Error(`eToro: instrument not found for symbol "${symbol}"`);
  instrumentCache.set(key, match.instrumentId);
  return match.instrumentId;
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
