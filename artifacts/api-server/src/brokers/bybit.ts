import { RestClientV5 } from "bybit-api";
import type { OrderParamsV5, PositionInfoParamsV5 } from "bybit-api";

let _client: RestClientV5 | null = null;

function getClient(): RestClientV5 {
  if (_client) return _client;
  const key     = process.env["BYBIT_API_KEY"];
  const secret  = process.env["BYBIT_API_SECRET"];
  const testnet = process.env["BYBIT_TESTNET"] === "true";
  if (!key || !secret) {
    throw new Error("BYBIT_API_KEY and BYBIT_API_SECRET env vars are required");
  }
  _client = new RestClientV5({ key, secret, testnet });
  return _client;
}

export async function placeOrder(
  symbol: string,
  side: "Buy" | "Sell",
  amountUsd: number,
): Promise<{ orderId?: string }> {
  const client = getClient();
  const params: OrderParamsV5 = {
    category:   "spot",
    symbol:     `${symbol.toUpperCase()}USDT`,
    side,
    orderType:  "Market",
    qty:        String(amountUsd),
    marketUnit: "quoteCoin",
  };
  const res = await client.submitOrder(params);
  if (res.retCode !== 0) {
    throw new Error(`Bybit order failed [${res.retCode}]: ${res.retMsg}`);
  }
  return { orderId: res.result.orderId };
}

export async function getPositions(): Promise<unknown> {
  const client = getClient();
  const params: PositionInfoParamsV5 = { category: "linear" };
  const res = await client.getPositionInfo(params);
  if (res.retCode !== 0) {
    throw new Error(`Bybit getPositions failed [${res.retCode}]: ${res.retMsg}`);
  }
  return res.result.list ?? [];
}
