import { db, profileTable } from "@workspace/db";
import { eq }               from "drizzle-orm";
import { getProfile }       from "./profile";
import * as okx             from "../brokers/okx";
import * as bybit           from "../brokers/bybit";
import { getPortfolio }     from "../brokers/etoro";

export interface BrokerBalances {
  okx:   number;
  bybit: number;
  etoro: number;
  total: number;
}

interface EtoroShape {
  clientPortfolio?: { credit?: number; positions?: Array<{ amount?: number }> };
}

async function fetchOKX(): Promise<number> {
  try { return (await okx.getAccountBalance()).availableBalance; } catch { return 0; }
}
async function fetchBybit(): Promise<number> {
  try { return (await bybit.getBalance()).availableBalance; } catch { return 0; }
}
async function fetchEtoro(): Promise<number> {
  try {
    const p = (await getPortfolio()) as EtoroShape;
    return p?.clientPortfolio?.credit ?? 0;
  } catch { return 0; }
}

export async function getAllBrokerBalances(): Promise<BrokerBalances> {
  const [okxBal, bybitBal, etoroBal] = await Promise.all([
    fetchOKX(), fetchBybit(), fetchEtoro(),
  ]);
  const total = okxBal + bybitBal + etoroBal;
  console.log(
    "Broker balances —",
    "OKX:", okxBal,
    "Bybit:", bybitBal,
    "eToro:", etoroBal,
    "Total:", total,
  );
  return { okx: okxBal, bybit: bybitBal, etoro: etoroBal, total };
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
