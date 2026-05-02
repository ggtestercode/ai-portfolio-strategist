import { llm }                      from "./llmRouter";
import { cache, TTL, CacheKey }     from "./contextCache";
import { approvalGate, buildProposal } from "./approvalGate";
import { getWatchlist, type WatchlistEntry } from "./watchlist";
import { fetchAssetData, type AssetData }    from "../data/marketData";
import { db, profileTable, holdingsTable }   from "@workspace/db";

export type Recommendation = "STRONG BUY" | "BUY" | "WATCH" | "AVOID";

export interface ScanOpportunity {
  symbol:         string;
  assetClass:     string;
  score:          number;
  recommendation: Recommendation;
  reasoning:      string;
  price:          number;
  dataTimestamp:  string;
}

export interface ScanResult {
  opportunities:  ScanOpportunity[];
  scanTimestamp:  string;
  summary:        string;
}

const FALLBACK_RESULT: ScanResult = {
  opportunities: [],
  scanTimestamp: new Date().toISOString(),
  summary:       "Scan unavailable",
};

async function fetchBatch(entries: WatchlistEntry[]): Promise<AssetData[]> {
  const settled = await Promise.allSettled(
    entries.map(e => fetchAssetData(e.symbol, e.assetClass))
  );
  return settled
    .filter((r): r is PromiseFulfilledResult<AssetData> => r.status === "fulfilled")
    .map(r => r.value);
}

async function fetchAllData(watchlist: WatchlistEntry[]): Promise<AssetData[]> {
  const BATCH = 10;
  const results: AssetData[] = [];
  for (let i = 0; i < watchlist.length; i += BATCH) {
    const chunk = watchlist.slice(i, i + BATCH);
    results.push(...await fetchBatch(chunk));
    if (i + BATCH < watchlist.length) await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

function formatRow(d: AssetData, assetClass: string): string {
  const vol = d.volume > 1e9 ? `${(d.volume / 1e9).toFixed(1)}B`
            : d.volume > 1e6 ? `${(d.volume / 1e6).toFixed(1)}M` : `${d.volume}`;
  return `${d.symbol}|${assetClass}|$${d.price.toFixed(2)}|${d.change7d > 0 ? "+" : ""}${d.change7d}%|${d.change30d > 0 ? "+" : ""}${d.change30d}%|RSI${d.rsi}|${vol}`;
}

export async function runScan(): Promise<ScanResult> {
  return cache.get(CacheKey.marketScan(), TTL.MARKET_SCAN, async () => {
    const [watchlist, profile, holdings] = await Promise.all([
      getWatchlist(),
      db.select().from(profileTable).limit(1).then(r => r[0]),
      db.select().from(holdingsTable),
    ]);

    // Attach assetClass lookup
    const classMap = Object.fromEntries(watchlist.map(e => [e.symbol, e.assetClass]));

    const assetData = await fetchAllData(watchlist);
    if (assetData.length < 3) {
      console.warn("[scanner] Insufficient data for scan");
      return FALLBACK_RESULT;
    }

    const tableRows = assetData.map(d => formatRow(d, classMap[d.symbol] ?? "Unknown"));
    const holdingSummary = holdings.map(h => `${h.symbol}:$${(h.quantity * h.price).toFixed(0)}`).join(" ");
    const totalPortfolio = holdings.reduce((s, h) => s + h.quantity * h.price, 0);

    const systemContext = [
      "You are an elite portfolio analyst. Respond with ONLY valid JSON — no markdown, no prose.",
      `Schema: {"opportunities":[{"symbol":"","assetClass":"","score":0-100,"recommendation":"STRONG BUY|BUY|WATCH|AVOID","reasoning":"","price":0,"dataTimestamp":""}],"scanTimestamp":"","summary":""}`,
      "Rules: rank exactly 5 opportunities. Score 80-100=STRONG BUY, 60-79=BUY, 40-59=WATCH, <40=AVOID.",
      "Consider: RSI <30 oversold (bullish), RSI >70 overbought (bearish). momentum (7d/30d), volume, diversification.",
    ].join("\n");

    const prompt = [
      `Portfolio: $${totalPortfolio.toFixed(0)} total. Holdings: ${holdingSummary || "none"}.`,
      `Risk tolerance: ${profile?.riskTolerance ?? "medium"}. Strategy: ${profile?.strategyType ?? "Balanced Growth"}.`,
      `Today UTC: ${new Date().toISOString()}`,
      ``,
      `Market data (Symbol|Class|Price|7d%|30d%|RSI|Volume):`,
      tableRows.join("\n"),
    ].join("\n");

    const res = await llm.json<ScanResult>({
      taskType:      "market_scan",
      systemContext,
      prompt,
      schema: {
        type: "object",
        properties: {
          opportunities: { type: "array" },
          scanTimestamp: { type: "string" },
          summary:       { type: "string" },
        },
        required: ["opportunities", "scanTimestamp", "summary"],
      },
      fallback: FALLBACK_RESULT,
    });

    if (!res.parseSuccess) return FALLBACK_RESULT;

    const result = res.data;
    result.scanTimestamp = new Date().toISOString();

    // Auto-propose top BUY / STRONG BUY opportunities
    if (profile) {
      const tradeAmount = (profile.totalCapital ?? 10000) * 0.02;
      const autoPropose = result.opportunities.filter(
        o => o.recommendation === "BUY" || o.recommendation === "STRONG BUY"
      ).slice(0, 2);

      for (const opp of autoPropose) {
        const assetClass = classMap[opp.symbol] ?? opp.assetClass ?? "Equity";
        const proposal   = buildProposal({
          symbol:        opp.symbol,
          side:          "buy",
          amountUsd:     Math.round(tradeAmount),
          assetClass,
          rationale:     `[Scanner] ${opp.recommendation} score=${opp.score}. ${opp.reasoning}`,
          score:         opp.score,
          currentPrice:  opp.price,
          dataTimestamp: opp.dataTimestamp,
        });
        approvalGate.submit(proposal).catch(e =>
          console.error(`[scanner] Auto-propose ${opp.symbol} failed:`, e)
        );
      }
    }

    return result;
  });
}

export function scheduleScan(): void {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;

  // First scan after a short delay so the server is fully up
  setTimeout(() => {
    runScan().catch(e => console.error("[scanner] Initial scan failed:", e));
  }, 10_000);

  setInterval(() => {
    cache.invalidate(CacheKey.marketScan());
    runScan().catch(e => console.error("[scanner] Scheduled scan failed:", e));
  }, FOUR_HOURS);

  console.log("[scanner] Scheduled — runs every 4 h (first scan in 10 s)");
}
