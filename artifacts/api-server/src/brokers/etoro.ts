const BASE_URL = "https://public-api.etoro.com/api/v1";

function getHeaders(): Record<string, string> {
  const publicKey = process.env["ETORO_PUBLIC_KEY"];
  const userKey   = process.env["ETORO_USER_KEY"];
  if (!publicKey || !userKey) {
    throw new Error("ETORO_PUBLIC_KEY and ETORO_USER_KEY env vars are required");
  }
  return {
    "Content-Type":       "application/json",
    "X-ETORO-API-KEY":    publicKey,
    "Authorization":      `Bearer ${userKey}`,
  };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
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

export async function openPosition(
  symbol: string,
  amountUsd: number,
  isBuy: boolean,
): Promise<{ positionId: string }> {
  return request<{ positionId: string }>("POST", "/trading/positions", {
    instrumentName: symbol,
    isBuy,
    amount: amountUsd,
    leverage: 1,
  });
}

export async function closePosition(positionId: string): Promise<void> {
  await request<unknown>("DELETE", `/trading/positions/${positionId}`);
}

export async function getPortfolio(): Promise<unknown> {
  return request<unknown>("GET", "/trading/portfolio");
}
