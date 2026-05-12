import { llm }                      from "./llmRouter";
import { cache, TTL, CacheKey }     from "./contextCache";
import { getWatchlist, type WatchlistEntry } from "./watchlist";
import { fetchAssetData, type AssetData }    from "../data/marketData";
import { getKlines, getFundingRate, getOpenInterest } from "../brokers/bybit";
import { getRecentMemory }                   from "./tradeMemoryLib";
import { db, profileTable, holdingsTable }   from "@workspace/db";

export type Recommendation = "STRONG BUY" | "BUY" | "WATCH" | "AVOID";
export type Conviction     = "low" | "medium" | "high" | "strong_buy" | "strong_sell";

export interface ScanOpportunity {
  symbol:              string;
  assetClass:          string;
  score:               number;
  recommendation:      Recommendation;
  reasoning:           string;
  price:               number;
  dataTimestamp:       string;
  // Extended multi-timeframe fields
  direction?:          "long" | "short" | "neutral";
  conviction?:         Conviction;
  entry?:              number;
  stopLoss?:           number;
  takeProfit?:         number;
  leverage?:           number;
  positionSizeUsd?:    number;
  timeframeAlignment?: string;
  orderType?:          "market" | "limit";
  limitPrice?:         number;
  timeInForce?:        "IOC" | "GTC";
  orderReasoning?:     string;
  // Sprint 7A — risk/SL/TP metadata
  riskRewardRatio?:     number;
  stopLossMethod?:      "swing_low" | "ATR" | "percent" | "support";
  stopLossReasoning?:   string;
  takeProfitReasoning?: string;
  rrReasoning?:         string;
  fundingRateContext?:  string;
  openInterestContext?: string;
}

// ── Technical indicators ──────────────────────────────────────────────────────
function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = (closes[i]! * k) + (ema * (1 - k));
  return ema;
}

async function fetchMTFData(symbol: string): Promise<string> {
  const intervals: Array<[string, string]> = [["1","1m"],["15","15m"],["60","1h"],["240","4h"],["D","1D"]];
  const parts: string[] = [];
  for (const [iv, label] of intervals) {
    try {
      const klines = await getKlines(symbol, iv, 50);
      const closes = klines.map(k => k.close);
      const rsi    = calcRSI(closes, 14).toFixed(1);
      const ema20  = calcEMA(closes, 20).toFixed(2);
      const ema50  = calcEMA(closes, 50).toFixed(2);
      const last   = closes[closes.length - 1]?.toFixed(2) ?? "N/A";
      parts.push(`${label}: price=$${last} RSI=${rsi} EMA20=$${ema20} EMA50=$${ema50}`);
    } catch { parts.push(`${label}: unavailable`); }
  }
  return parts.join(" | ");
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
    const [watchlist, profile, holdings, tradeMemory] = await Promise.all([
      getWatchlist(),
      db.select().from(profileTable).limit(1).then(r => r[0]),
      db.select().from(holdingsTable),
      getRecentMemory(20).catch(() => ""),
    ]);

    const classMap = Object.fromEntries(watchlist.map(e => [e.symbol, e.assetClass]));
    const assetData = await fetchAllData(watchlist);
    if (assetData.length < 3) { console.warn("[scanner] Insufficient data"); return FALLBACK_RESULT; }

    // Multi-timeframe data + funding rates + open interest for top crypto symbols
    const cryptoSyms = watchlist.filter(e => e.assetClass === "Crypto").slice(0, 5).map(e => e.symbol);
    const mtfLines:     string[] = [];
    const fundingLines: string[] = [];
    for (const sym of cryptoSyms) {
      try {
        const [mtf, fr, oi] = await Promise.all([
          fetchMTFData(sym),
          getFundingRate(sym).catch(() => ({ rate: 0, nextFundingTime: 0 })),
          getOpenInterest(sym).catch(() => 0),
        ]);
        mtfLines.push(`${sym} MTF: ${mtf}`);
        const rSign = fr.rate >= 0 ? "+" : "";
        fundingLines.push(`${sym} fundingRate=${rSign}${(fr.rate * 100).toFixed(4)}% OI=${oi > 1e9 ? `${(oi/1e9).toFixed(2)}B` : oi > 1e6 ? `${(oi/1e6).toFixed(1)}M` : oi.toFixed(0)}`);
      } catch { /* skip */ }
    }

    const tableRows      = assetData.map(d => formatRow(d, classMap[d.symbol] ?? "Unknown"));
    const holdingSummary = holdings.map(h => `${h.symbol}:$${(h.quantity * h.price).toFixed(0)}`).join(" ");
    const totalPortfolio = holdings.reduce((s, h) => s + h.quantity * h.price, 0);

    const risk            = (profile?.riskTolerance ?? "medium").toLowerCase();
    const targetReturn    = profile?.targetReturnPct ?? 10;
    const capital         = profile?.totalCapital ?? 200;
    const strategyName    = profile?.strategyType ?? "Balanced";
    const maxPosition     = Math.max(10, (totalPortfolio || capital) * 0.5);

    const riskDirective =
      risk === "extreme" || risk === "high"
        ? `EXTREME/HIGH risk: surface only high-conviction momentum plays. Crypto leverage up to 50x. Target: ${targetReturn}%/period.`
        : risk === "low"
          ? `LOW risk: prefer defensive, low-volatility assets. Avoid leverage >3x. Target: ${targetReturn}%/period.`
          : `MEDIUM risk: balanced approach. Leverage max 10x. Target: ${targetReturn}%/period.`;

    const systemContext = [
      "You are an elite quant trader. Respond with ONLY valid JSON — no markdown, no prose.",
      `Schema: {"opportunities":[{"symbol":"","assetClass":"","score":0-100,"recommendation":"STRONG BUY|BUY|WATCH|AVOID","reasoning":"","price":0,"dataTimestamp":"","direction":"long|short|neutral","conviction":"low|medium|high|strong_buy|strong_sell","entry":0,"stopLoss":0,"takeProfit":0,"leverage":1,"positionSizeUsd":0,"timeframeAlignment":"","orderType":"market|limit","limitPrice":0,"timeInForce":"IOC|GTC","orderReasoning":"","riskRewardRatio":0,"stopLossMethod":"swing_low|ATR|percent|support","stopLossReasoning":"","takeProfitReasoning":"","rrReasoning":"","fundingRateContext":"","openInterestContext":""}],"scanTimestamp":"","summary":""}`,
      "Rules: rank exactly 5 opportunities. 80-100=STRONG BUY(strong_buy), 60-79=BUY(high), 40-59=WATCH(medium), <40=AVOID.",
      "DIRECTION BIAS: You have NO bias toward long or short positions. Analyse each symbol objectively: strong uptrend + momentum → direction=long; strong downtrend + momentum → direction=short; ranging/unclear → direction=neutral. Short positions are equally valid as longs. Use conviction=strong_sell for high-confidence shorts.",
      "FUNDING RATE CONTRARIAN: Very positive funding (>0.05%) = market overleveraged long → contrarian SHORT opportunity. Very negative funding (<-0.05%) = market overleveraged short → contrarian LONG opportunity.",
      "Multi-timeframe alignment: confirm trend across 1h, 4h, 1D before signalling. Higher conviction = more TF alignment.",
      "RSI <30 oversold (bullish bias), RSI >70 overbought (bearish bias). EMA20>EMA50 = uptrend; EMA20<EMA50 = downtrend.",
      `User profile: Strategy=${strategyName}, Risk=${risk}, Target=${targetReturn}%/period, Capital=$${capital}. Only suggest signals matching this profile.`,
      riskDirective,
      "Leverage: up to 50x crypto, 20x stocks. stopLoss must be realistic (5-15% from entry for futures).",
      "For LONGS: stopLoss below entry, takeProfit above entry. For SHORTS: stopLoss above entry, takeProfit below entry.",
      "stopLossMethod: 'swing_low' if using recent swing low/high, 'ATR' if volatility-based, 'percent' if fixed %, 'support' if key level.",
      "riskRewardRatio: for longs = (takeProfit-entry)/(entry-stopLoss); for shorts = (entry-takeProfit)/(stopLoss-entry). Must be ≥ 1.5.",
      "fundingRateContext: interpret the funding rate (positive=longs pay shorts=crowded long, negative=shorts pay=crowded short).",
      "openInterestContext: interpret OI trend (rising OI = new money entering, falling OI = positions closing).",
      "Order type decision:",
      "  Use MARKET order (IOC) only when: price breaking out with strong momentum, strong_buy/strong_sell with volume confirmation, missing the move is worse than bad entry.",
      "  Use LIMIT order (GTC) when: price is mid-range (not at support/resistance), better entry available on pullback — set limitPrice at nearest support (long) or resistance (short).",
      "  NEVER enter mid-range with a market order when a pullback entry is available. Default to limit unless breakout is confirmed.",
      `Max position: $${maxPosition.toFixed(0)} (50% of capital).`,
    ].join("\n");

    const prompt = [
      `Portfolio: $${totalPortfolio.toFixed(0)} total. Holdings: ${holdingSummary || "none"}.`,
      `Risk: ${profile?.riskTolerance ?? "high"}. Strategy: ${profile?.strategyType ?? "Momentum"}.`,
      `UTC: ${new Date().toISOString()}`,
      ``,
      mtfLines.length ? `Multi-timeframe data:\n${mtfLines.join("\n")}\n` : "",
      fundingLines.length ? `Funding rates & open interest:\n${fundingLines.join("\n")}\n` : "",
      `Market snapshot (Symbol|Class|Price|7d%|30d%|RSI|Volume):`,
      tableRows.join("\n"),
      ``,
      tradeMemory ? `Trade memory (last reflections):\n${tradeMemory}` : "",
    ].filter(Boolean).join("\n");

    const res = await llm.json<ScanResult>({
      taskType:      "market_scan",
      systemContext,
      prompt,
      schema: {
        type: "object",
        properties: {
          opportunities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                symbol: { type: "string" }, assetClass: { type: "string" },
                score: { type: "number" }, recommendation: { type: "string" },
                reasoning: { type: "string" }, price: { type: "number" },
                dataTimestamp: { type: "string" },
                direction: { type: "string" }, conviction: { type: "string" },
                entry: { type: "number" }, stopLoss: { type: "number" },
                takeProfit: { type: "number" }, leverage: { type: "number" },
                positionSizeUsd: { type: "number" }, timeframeAlignment: { type: "string" },
                orderType: { type: "string" }, limitPrice: { type: "number" },
                timeInForce: { type: "string" }, orderReasoning: { type: "string" },
                riskRewardRatio: { type: "number" }, stopLossMethod: { type: "string" },
                stopLossReasoning: { type: "string" }, takeProfitReasoning: { type: "string" },
                rrReasoning: { type: "string" }, fundingRateContext: { type: "string" },
                openInterestContext: { type: "string" },
              },
            },
          },
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
