import {
  db,
  targetAllocationsTable,
  strategyOptionsTable,
  profileTable,
} from "@workspace/db";
import { approvalGate, buildProposal } from "./approvalGate";
import * as okx from "../brokers/okx";
import * as bybit from "../brokers/bybit";

const SKIP_CLASSES = new Set([
  "Cash", "cash", "Stablecoin", "stablecoin",
  "Bonds", "bonds", "Bond", "bond",
]);

const FALLBACK_SYMBOLS: Record<string, Array<{ symbol: string; name: string; weightPct: number }>> = {
  Crypto: [
    { symbol: "BTC-USDT", name: "Bitcoin",  weightPct: 40 },
    { symbol: "ETH-USDT", name: "Ethereum", weightPct: 30 },
    { symbol: "SOL-USDT", name: "Solana",   weightPct: 30 },
  ],
  Equity: [
    { symbol: "SPY",  name: "S&P 500 ETF", weightPct: 40 },
    { symbol: "AAPL", name: "Apple",        weightPct: 30 },
    { symbol: "MSFT", name: "Microsoft",    weightPct: 30 },
  ],
};

export interface ExecuteOrder {
  symbol:     string;
  assetClass: string;
  amountUsd:  number;
  status:     "queued" | "executed" | "skipped" | "failed";
  reason:     string;
}

export interface ExecuteResult {
  availableCash:     number;
  totalDeployed:     number;
  orders:            ExecuteOrder[];
  allocationSummary: Array<{ assetClass: string; targetPct: number; amountUsd: number }>;
  mode:              string;
}

async function getBrokerCash(): Promise<number> {
  try {
    const bal = await okx.getAccountBalance();
    if (bal.availableBalance > 0) return bal.availableBalance;
  } catch { /* fall through */ }
  try {
    const bal = await bybit.getBalance();
    if (bal.availableBalance > 0) return bal.availableBalance;
  } catch { /* fall through */ }
  return 0;
}

export async function buildPortfolioFromTargets(): Promise<ExecuteResult> {
  const [targets, profile, allOptions, gateConfig] = await Promise.all([
    db.select().from(targetAllocationsTable),
    db.select().from(profileTable).limit(1).then(r => r[0]),
    db.select().from(strategyOptionsTable),
    approvalGate.getConfig(),
  ]);

  if (targets.length === 0) {
    return {
      availableCash: 0, totalDeployed: 0, orders: [],
      allocationSummary: [], mode: gateConfig.mode,
    };
  }

  const brokerCash  = await getBrokerCash();
  const profileCap  = profile?.totalCapital ?? 0;
  // Use profile capital as the reference; cap by broker cash so we don't over-commit
  const budget      = profileCap > 0 ? Math.min(brokerCash || profileCap, profileCap) : brokerCash;

  // Build assetClass → deduplicated picks map from all strategy options
  const picksByClass: Record<string, Array<{ symbol: string; name: string; assetClass: string; weightPct: number }>> = {};
  for (const opt of allOptions) {
    for (const pick of opt.picks) {
      const cls = pick.assetClass;
      if (!picksByClass[cls]) picksByClass[cls] = [];
      const existing = picksByClass[cls]!.find(p => p.symbol === pick.symbol);
      if (existing) {
        existing.weightPct = Math.max(existing.weightPct, pick.weightPct);
      } else {
        picksByClass[cls]!.push({ symbol: pick.symbol, name: pick.name, assetClass: cls, weightPct: pick.weightPct });
      }
    }
  }

  const orders:            ExecuteOrder[]                      = [];
  const allocationSummary: ExecuteResult["allocationSummary"] = [];
  let totalDeployed = 0;

  for (const target of targets) {
    const { assetClass, targetPct } = target;
    const allocUsd = budget * (targetPct / 100);
    allocationSummary.push({ assetClass, targetPct, amountUsd: Number(allocUsd.toFixed(2)) });

    if (SKIP_CLASSES.has(assetClass)) {
      orders.push({ symbol: assetClass, assetClass, amountUsd: allocUsd, status: "skipped", reason: "Cash/bond allocation retained as cash" });
      continue;
    }

    const rawPicks = picksByClass[assetClass] ?? FALLBACK_SYMBOLS[assetClass] ?? [];
    if (rawPicks.length === 0) {
      orders.push({ symbol: assetClass, assetClass, amountUsd: allocUsd, status: "skipped", reason: "No symbols configured for this asset class" });
      continue;
    }

    const totalW = rawPicks.reduce((s, p) => s + p.weightPct, 0);
    const picks  = totalW > 0 ? rawPicks.map(p => ({ ...p, weightPct: p.weightPct / totalW })) : rawPicks;

    for (const pick of picks) {
      const orderAmount = allocUsd * pick.weightPct;
      if (orderAmount < 5) {
        orders.push({ symbol: pick.symbol, assetClass, amountUsd: orderAmount, status: "skipped", reason: `Below $5 minimum ($${orderAmount.toFixed(2)})` });
        continue;
      }

      const proposal = buildProposal({
        symbol:    pick.symbol,
        side:      "buy",
        amountUsd: Math.round(orderAmount * 100) / 100,
        assetClass,
        rationale: `[Strategy Execute] ${assetClass} ${targetPct}% of $${budget.toFixed(0)}`,
      });

      try {
        const result = await approvalGate.submit(proposal);
        const status = result.action === "executed" ? "executed" : "queued";
        orders.push({ symbol: pick.symbol, assetClass, amountUsd: orderAmount, status, reason: result.message });
        totalDeployed += orderAmount;
      } catch (err: any) {
        orders.push({ symbol: pick.symbol, assetClass, amountUsd: orderAmount, status: "failed", reason: err.message });
      }
    }
  }

  return { availableCash: brokerCash, totalDeployed, orders, allocationSummary, mode: gateConfig.mode };
}
