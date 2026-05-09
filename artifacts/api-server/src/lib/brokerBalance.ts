import { db, profileTable } from "@workspace/db";
import { eq }               from "drizzle-orm";
import { getProfile }       from "./profile";
import * as bybit           from "../brokers/bybit";

export interface BrokerBalances {
  okx:   number;
  bybit: number;
  etoro: number;
  total: number;
}

async function fetchBybit(): Promise<number> {
  try { return (await bybit.getBalance()).totalEquity; } catch { return 0; }
}

export async function getAllBrokerBalances(): Promise<BrokerBalances> {
  const bybitBal = await fetchBybit();
  console.log("Broker balances — Bybit:", bybitBal);
  return { okx: 0, bybit: bybitBal, etoro: 0, total: bybitBal };
}

// Fetches live broker balances and syncs profileTable.totalCapital so that
// approvalGate, cronScanner, aiResponder, and marketScanner all read the
// real balance from DB without making additional broker API calls.
export async function syncTotalCapitalToDB(): Promise<BrokerBalances> {
  const balances = await getAllBrokerBalances();
  if (balances.total > 0) {
    try {
      const profile = await getProfile();
      await db
        .update(profileTable)
        .set({ totalCapital: balances.total })
        // @ts-ignore — pre-existing drizzle-orm dual-version type conflict
        .where(eq(profileTable.id, profile.id));
    } catch (e) {
      console.error("[brokerBalance] syncTotalCapital failed:", e);
    }
  }
  return balances;
}
