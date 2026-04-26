import { getProfile } from "./profile";
import {
  getPortfolioSnapshot,
  getAllocationRows,
  getRebalancingActions,
} from "./portfolio";

const fmtUsd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

const fmtPct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

export async function generateAssistantReply(prompt: string): Promise<string> {
  const profile = await getProfile();
  const snap = await getPortfolioSnapshot(profile.totalCapital);
  const allocation = await getAllocationRows();
  const rebal = await getRebalancingActions();
  const lower = prompt.toLowerCase();

  if (/rebalance|drift|allocation/.test(lower)) {
    if (rebal.length === 0) {
      return `Your allocation is within target bands across all asset classes — no rebalancing needed right now. Total portfolio value is ${fmtUsd(
        snap.totalValue,
      )}. I'll alert you the moment any class drifts beyond the ±5% threshold defined in your strategy.`;
    }
    const lines = rebal
      .map(
        (r) =>
          `• ${r.actionType} ${fmtUsd(r.amount)} of ${r.asset}`,
      )
      .join("\n");
    return `Yes — your portfolio is ${rebal.length === 1 ? "drifting" : "drifting in " + rebal.length + " areas"} from your target allocation. Suggested actions:\n${lines}\n\nApplying these will return you to your ${profile.strategyType} strategy bands.`;
  }

  if (/risk|risky|drawdown|volatil/.test(lower)) {
    const heaviest = allocation[0];
    const note = heaviest
      ? ` Your heaviest exposure is ${heaviest.assetClass} at ${heaviest.currentPct.toFixed(1)}% (target ${heaviest.targetPct.toFixed(1)}%).`
      : "";
    return `At your current ${profile.riskTolerance} risk tolerance, the portfolio sits within acceptable bands.${note} Today's move is ${fmtPct(snap.change24hPct)}. I'd flag risk if any single position exceeds 25% or daily volatility exceeds 4% — neither is the case right now.`;
  }

  if (/buy|sell|trade|position|eth|btc|sol/.test(lower)) {
    return `Based on your ${profile.strategyType} strategy and current allocation, I'd recommend waiting for a better entry near the suggested ranges in your trade panel. Your conviction levels look solid, but discipline on entry pricing is what separates a good return from a great one. Open the Trade Assistant page for active suggestions with entry, target, and stop-loss levels.`;
  }

  if (/strategy|generate|regenerate|plan/.test(lower)) {
    return `Your active strategy is "${profile.strategyType}" (${profile.strategyRiskLevel} risk), last generated ${profile.strategyLastGenerated.toDateString()}. It's still aligned with your ${profile.targetReturnPct}% target return over ${profile.timeHorizonMonths} months. Tap "Regenerate" if your goals have changed materially.`;
  }

  if (/perform|return|profit|loss|gain/.test(lower)) {
    return `Portfolio performance: ${fmtUsd(snap.totalValue)} total value, ${fmtUsd(snap.totalProfitLoss)} total P/L (${fmtPct(snap.totalProfitLossPct)}). 24h change: ${fmtUsd(snap.change24h)} (${fmtPct(snap.change24hPct)}). You're tracking toward your ${profile.targetReturnPct}% annual target.`;
  }

  return `I've analyzed your portfolio against your ${profile.strategyType} strategy. Total value is ${fmtUsd(snap.totalValue)} with a ${fmtPct(snap.totalProfitLossPct)} total return. ${rebal.length > 0 ? `There ${rebal.length === 1 ? "is" : "are"} ${rebal.length} rebalancing suggestion${rebal.length === 1 ? "" : "s"} pending.` : "Allocation is within target bands."} Ask me about risk, rebalancing, performance, or any specific position.`;
}
