import { db, holdingsTable, targetAllocationsTable } from "@workspace/db";

const STATUS_THRESHOLD_IN_RANGE = 1.5;
const STATUS_THRESHOLD_SLIGHT = 4;

export type AllocationRow = {
  assetClass: string;
  currentPct: number;
  targetPct: number;
  differencePct: number;
  status: "In Range" | "Slightly High" | "Slightly Low" | "Out of Range";
};

export async function loadHoldings() {
  return db.select().from(holdingsTable);
}

export async function loadTargets() {
  return db.select().from(targetAllocationsTable);
}

export type PortfolioSnapshot = {
  totalValue: number;
  totalProfitLoss: number;
  totalProfitLossPct: number;
  change24h: number;
  change24hPct: number;
  byAssetClass: Record<string, number>;
};

export async function getPortfolioSnapshot(
  totalCapital: number,
): Promise<PortfolioSnapshot> {
  const holdings = await loadHoldings();
  const totalValue = holdings.reduce((sum, h) => sum + h.quantity * h.price, 0);

  const change24h = holdings.reduce((sum, h) => {
    const value = h.quantity * h.price;
    const previous = value / (1 + h.change24hPct / 100);
    return sum + (value - previous);
  }, 0);
  const change24hPct = totalValue > 0 ? (change24h / (totalValue - change24h)) * 100 : 0;

  // P/L = sum of 24h gains on each position (unrealized, not vs total capital)
  const totalProfitLoss = holdings.reduce((sum, h) => {
    const value    = h.quantity * h.price;
    const costBase = value / (1 + h.change24hPct / 100);
    return sum + (value - costBase);
  }, 0);
  const totalProfitLossPct = totalValue > 0 ? (totalProfitLoss / totalValue) * 100 : 0;

  const byAssetClass: Record<string, number> = {};
  for (const h of holdings) {
    const v = h.quantity * h.price;
    byAssetClass[h.assetClass] = (byAssetClass[h.assetClass] ?? 0) + v;
  }

  return {
    totalValue,
    totalProfitLoss,
    totalProfitLossPct,
    change24h,
    change24hPct,
    byAssetClass,
  };
}

export async function getAllocationRows(): Promise<AllocationRow[]> {
  const targets = await loadTargets();
  const snapshot = await getPortfolioSnapshot(0);
  const total = snapshot.totalValue;

  return targets
    .map((t) => {
      const value = snapshot.byAssetClass[t.assetClass] ?? 0;
      const currentPct = total > 0 ? (value / total) * 100 : 0;
      const diff = currentPct - t.targetPct;
      let status: AllocationRow["status"];
      const absDiff = Math.abs(diff);
      if (absDiff < STATUS_THRESHOLD_IN_RANGE) status = "In Range";
      else if (absDiff < STATUS_THRESHOLD_SLIGHT)
        status = diff > 0 ? "Slightly High" : "Slightly Low";
      else status = "Out of Range";

      return {
        assetClass: t.assetClass,
        currentPct: Number(currentPct.toFixed(1)),
        targetPct: Number(t.targetPct.toFixed(1)),
        differencePct: Number(diff.toFixed(1)),
        status,
      };
    })
    .sort((a, b) => b.targetPct - a.targetPct);
}

export async function getRebalancingActions() {
  const rows = await getAllocationRows();
  const snapshot = await getPortfolioSnapshot(0);
  const total = snapshot.totalValue;
  return rows
    .filter((r) => Math.abs(r.differencePct) >= 1)
    .map((r) => {
      const targetValue = (r.targetPct / 100) * total;
      const currentValue = (r.currentPct / 100) * total;
      const delta = targetValue - currentValue;
      return {
        id: `reb-${r.assetClass.toLowerCase()}`,
        asset: r.assetClass,
        actionType: (delta >= 0 ? "Buy" : "Sell") as "Buy" | "Sell",
        amount: Number(Math.abs(delta).toFixed(2)),
      };
    });
}
