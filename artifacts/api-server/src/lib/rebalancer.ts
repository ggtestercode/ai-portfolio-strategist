import { llm }                          from "./llmRouter";
import { approvalGate, buildProposal }  from "./approvalGate";
import { buildPortfolioFromTargets }    from "./strategyExecutor";
import { db, holdingsTable, targetAllocationsTable, profileTable } from "@workspace/db";

interface RebalanceTrade {
  symbol:    string;
  assetClass: string;
  side:      "buy" | "sell";
  amountUsd: number;
  rationale: string;
}

interface RebalanceResult {
  trades:    RebalanceTrade[];
  summary:   string;
  timestamp: string;
}

const FALLBACK: RebalanceResult = { trades: [], summary: "Rebalance unavailable", timestamp: new Date().toISOString() };

async function buildRebalanceResult(): Promise<RebalanceResult> {
  const [holdings, targets, profile] = await Promise.all([
    db.select().from(holdingsTable),
    db.select().from(targetAllocationsTable),
    db.select().from(profileTable).limit(1).then(r => r[0]),
  ]);

  const totalValue = holdings.reduce((s, h) => s + h.quantity * h.price, 0);

  // Empty portfolio + targets set → build from scratch via strategy executor
  if (totalValue === 0 && targets.length > 0) {
    console.log("[rebalancer] Empty portfolio with targets — triggering initial portfolio build");
    const execResult = await buildPortfolioFromTargets();
    const trades = execResult.orders
      .filter(o => o.status === "queued" || o.status === "executed")
      .map(o => ({
        symbol:     o.symbol,
        assetClass: o.assetClass,
        side:       "buy" as const,
        amountUsd:  o.amountUsd,
        rationale:  "Initial portfolio build from strategy targets",
      }));
    return {
      trades,
      summary: `Initial build: $${execResult.totalDeployed.toFixed(0)} queued across ${trades.length} orders (mode: ${execResult.mode})`,
      timestamp: new Date().toISOString(),
    };
  }

  if (totalValue === 0) return { ...FALLBACK, summary: "No portfolio value to rebalance" };

  const currentAlloc = holdings.reduce<Record<string, number>>((acc, h) => {
    acc[h.assetClass] = (acc[h.assetClass] ?? 0) + h.quantity * h.price;
    return acc;
  }, {});

  const currentPct = Object.fromEntries(
    Object.entries(currentAlloc).map(([k, v]) => [k, +((v / totalValue) * 100).toFixed(1)])
  );

  const targetPct = Object.fromEntries(targets.map(t => [t.assetClass, t.targetPct]));

  const holdingLines = holdings.map(h =>
    `${h.symbol}(${h.assetClass}):qty=${h.quantity},price=$${h.price},value=$${(h.quantity * h.price).toFixed(0)}`
  ).join("; ");

  const allocLines = Object.keys({ ...currentPct, ...targetPct }).map(cls =>
    `${cls}: current=${currentPct[cls] ?? 0}%, target=${targetPct[cls] ?? 0}%`
  ).join("; ");

  const systemContext = [
    "You are a portfolio rebalancing specialist.",
    "Return only valid JSON. No markdown fences, no backticks, no explanation outside the JSON object.",
    `Schema: {"trades":[{"symbol":"","assetClass":"","side":"buy|sell","amountUsd":0,"rationale":""}],"summary":"","timestamp":""}`,
    "Only propose trades where drift exceeds 2%. Prefer selling over-allocated assets to fund under-allocated ones.",
    "Keep each trade ≤5% of total portfolio. Provide clear rationale for each trade.",
  ].join("\n");

  const prompt = [
    `Total portfolio: $${totalValue.toFixed(0)}. Risk: ${profile?.riskTolerance ?? "medium"}.`,
    `Holdings: ${holdingLines}`,
    `Allocation drift: ${allocLines}`,
    `Today UTC: ${new Date().toISOString()}`,
    `Propose the minimum trades needed to bring allocations back to targets.`,
    `Return only valid JSON. No markdown fences, no backticks, no explanation outside the JSON object.`,
  ].join("\n");

  const res = await llm.json<RebalanceResult>({
    taskType:      "rebalance_plan",
    systemContext,
    prompt,
    schema: {
      type: "object",
      properties: {
        trades:    { type: "array" },
        summary:   { type: "string" },
        timestamp: { type: "string" },
      },
      required: ["trades", "summary", "timestamp"],
    },
    fallback: FALLBACK,
  });

  if (!res.parseSuccess) return FALLBACK;
  const result = res.data;
  result.timestamp = new Date().toISOString();
  return result;
}

export async function checkAndRebalance(): Promise<RebalanceResult> {
  try {
    const result = await buildRebalanceResult();

    // Submit all proposed trades through the approval gate
    for (const t of result.trades) {
      const proposal = buildProposal({
        symbol:    t.symbol,
        side:      t.side,
        amountUsd: t.amountUsd,
        assetClass: t.assetClass,
        rationale: `[Rebalance] ${t.rationale}`,
      });
      approvalGate.submit(proposal).catch(e =>
        console.error(`[rebalancer] Submit ${t.symbol} failed:`, e)
      );
    }

    return result;
  } catch (err) {
    console.error("[rebalancer] checkAndRebalance failed:", err);
    return FALLBACK;
  }
}

export async function rebalanceNow(): Promise<RebalanceResult> {
  return checkAndRebalance();
}
