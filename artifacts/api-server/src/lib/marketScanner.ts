import { llm }                      from "./llmRouter";
import { cache, TTL, CacheKey }     from "./contextCache";
import { getWatchlist, type WatchlistEntry } from "./watchlist";
import { fetchAssetData, type AssetData }    from "../data/marketData";
import { getKlines, getFundingRate, getOpenInterest, type BybitKline } from "../brokers/bybit";
import { getRecentMemory }                   from "./tradeMemoryLib";
import { db, profileTable, holdingsTable }   from "@workspace/db";

export type Recommendation = "STRONG BUY" | "BUY" | "WATCH" | "AVOID";
export type Conviction     = "low" | "medium" | "high" | "strong_buy" | "strong_sell";
export type RegimeType     = "TRENDING_UP" | "TRENDING_DOWN" | "CHOPPY" | "EXHAUSTION" | "VOLATILE";

export interface MarketRegime {
  regime:     RegimeType;
  adx:        number;
  diPlus:     number;
  diMinus:    number;
  ema20_4h:   number;
  ema50_4h:   number;
  ema200_4h:  number;
  atr:        number;
  atrAvg30d:  number;
  summary:    string;
}

export interface ScanOpportunity {
  symbol:              string;
  assetClass:          string;
  score:               number;
  recommendation:      Recommendation;
  reasoning:           string;
  price:               number;
  dataTimestamp:       string;
  direction?:          "long" | "short" | "neutral";
  conviction?:         Conviction;
  entry?:              number;
  stopLoss?:           number;
  takeProfit?:         number;
  atr?:                number;
  tp1?:                number;
  tp2?:                number;
  leverage?:           number;
  positionSizeUsd?:    number;
  timeframeAlignment?: string;
  orderType?:          "market" | "limit";
  limitPrice?:         number;
  timeInForce?:        "IOC" | "GTC";
  orderReasoning?:     string;
  riskRewardRatio?:     number;
  stopLossMethod?:      "swing_low" | "ATR" | "percent" | "support";
  stopLossReasoning?:   string;
  takeProfitReasoning?: string;
  rrReasoning?:         string;
  fundingRateContext?:  string;
  openInterestContext?: string;
  regimeAlignment?:     string;
  rejectReasons?:       string[];
  scoreBreakdown?:      Record<string, number>;
  volume24h?:           number;
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
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = (closes[i]! * k) + (ema * (1 - k));
  return ema;
}

// ATR using Wilder's smoothing
export function calcATR(klines: BybitKline[], period = 14): number {
  if (klines.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i]!.high, l = klines[i]!.low, pc = klines[i - 1]!.close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Seed with simple average for first period
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]!) / period;
  return atr;
}

// Full Wilder ADX with +DI / -DI
function calcADX(klines: BybitKline[], period = 14): { adx: number; diPlus: number; diMinus: number } {
  if (klines.length < period * 2 + 1) return { adx: 0, diPlus: 0, diMinus: 0 };

  const trs: number[] = [], pdms: number[] = [], mdms: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i]!.high, l = klines[i]!.low, pc = klines[i - 1]!.close;
    const ph = klines[i - 1]!.high, pl = klines[i - 1]!.low;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove = h - ph, downMove = pl - l;
    pdms.push(upMove > downMove && upMove > 0 ? upMove : 0);
    mdms.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder smooth seed
  let atr  = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  let pdm  = pdms.slice(0, period).reduce((s, v) => s + v, 0) / period;
  let mdm  = mdms.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
    pdm = (pdm * (period - 1) + pdms[i]!) / period;
    mdm = (mdm * (period - 1) + mdms[i]!) / period;
  }

  const diPlus  = atr > 0 ? (pdm / atr) * 100 : 0;
  const diMinus = atr > 0 ? (mdm / atr) * 100 : 0;
  const diSum   = diPlus + diMinus;

  // DX series for ADX smoothing
  const dxs: number[] = [];
  let seedAtr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  let seedPdm = pdms.slice(0, period).reduce((s, v) => s + v, 0) / period;
  let seedMdm = mdms.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    seedAtr = (seedAtr * (period - 1) + trs[i]!) / period;
    seedPdm = (seedPdm * (period - 1) + pdms[i]!) / period;
    seedMdm = (seedMdm * (period - 1) + mdms[i]!) / period;
    const dp  = seedAtr > 0 ? (seedPdm / seedAtr) * 100 : 0;
    const dm  = seedAtr > 0 ? (seedMdm / seedAtr) * 100 : 0;
    const sum = dp + dm;
    dxs.push(sum > 0 ? (Math.abs(dp - dm) / sum) * 100 : 0);
  }

  const adx = dxs.length >= period
    ? dxs.slice(-period).reduce((s, v) => s + v, 0) / period
    : (dxs.reduce((s, v) => s + v, 0) / (dxs.length || 1));

  return { adx, diPlus: diSum > 0 ? diPlus : 0, diMinus: diSum > 0 ? diMinus : 0 };
}

export async function detectMarketRegime(): Promise<MarketRegime> {
  try {
    const [klines4h, klines1d] = await Promise.all([
      getKlines("BTCUSDT", "240", 60),  // 4h × 60 periods
      getKlines("BTCUSDT", "D", 30),    // daily × 30
    ]);

    if (klines4h.length < 28) {
      return { regime: "CHOPPY", adx: 0, diPlus: 0, diMinus: 0, ema20_4h: 0, ema50_4h: 0, ema200_4h: 0, atr: 0, atrAvg30d: 0, summary: "Insufficient data — defaulting to CHOPPY" };
    }

    const closes4h = klines4h.map(k => k.close);
    const { adx, diPlus, diMinus } = calcADX(klines4h, 14);
    const ema20_4h  = calcEMA(closes4h, 20);
    const ema50_4h  = calcEMA(closes4h, 50);
    const ema200_4h = calcEMA(closes4h, Math.min(200, closes4h.length));
    const atr       = calcATR(klines4h, 14);
    const rsi4h     = calcRSI(closes4h, 14);

    // 30-day ATR average from daily candles
    const atrAvg30d = calcATR(klines1d, 14);
    const atrRatio  = atrAvg30d > 0 ? atr / atrAvg30d : 1;

    const price     = closes4h[closes4h.length - 1] ?? 0;
    const prevADX   = klines4h.length >= 30 ? calcADX(klines4h.slice(0, -14), 14).adx : adx;

    let regime: RegimeType;
    let summary: string;

    if (atrRatio > 2.0) {
      regime  = "VOLATILE";
      summary = `ATR ${atrRatio.toFixed(1)}× above 30d avg — extreme volatility`;
    } else if (adx > 25 && prevADX > adx * 0.85 && rsi4h > 65 && price < ema20_4h) {
      // ADX was high but declining, RSI diverging
      regime  = "EXHAUSTION";
      summary = `ADX ${adx.toFixed(1)} declining, RSI ${rsi4h.toFixed(0)} diverging — trend exhaustion`;
    } else if (adx > 25 && diPlus > diMinus && price > ema20_4h && ema20_4h > ema50_4h) {
      regime  = "TRENDING_UP";
      summary = `ADX ${adx.toFixed(1)}, DI+ ${diPlus.toFixed(1)} > DI- ${diMinus.toFixed(1)}, price > EMA20 > EMA50`;
    } else if (adx > 25 && diMinus > diPlus && price < ema20_4h && ema20_4h < ema50_4h) {
      regime  = "TRENDING_DOWN";
      summary = `ADX ${adx.toFixed(1)}, DI- ${diMinus.toFixed(1)} > DI+ ${diPlus.toFixed(1)}, price < EMA20 < EMA50`;
    } else {
      regime  = "CHOPPY";
      summary = `ADX ${adx.toFixed(1)} < 25 — ranging/choppy, no clear trend`;
    }

    console.log(`[regime] BTC 4h: ${regime} | ADX=${adx.toFixed(1)} DI+=${diPlus.toFixed(1)} DI-=${diMinus.toFixed(1)} ATR=${atr.toFixed(0)} (${atrRatio.toFixed(1)}× avg)`);
    return { regime, adx, diPlus, diMinus, ema20_4h, ema50_4h, ema200_4h, atr, atrAvg30d, summary };
  } catch (e) {
    console.warn("[regime] Detection failed:", (e as Error).message);
    return { regime: "CHOPPY", adx: 0, diPlus: 0, diMinus: 0, ema20_4h: 0, ema50_4h: 0, ema200_4h: 0, atr: 0, atrAvg30d: 0, summary: "Detection failed — defaulting to CHOPPY" };
  }
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
  regime?:        MarketRegime;
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
    // Detect market regime first (BTC as proxy)
    const regime = await detectMarketRegime();

    const [watchlist, profile, holdings, tradeMemory] = await Promise.all([
      getWatchlist(),
      db.select().from(profileTable).limit(1).then(r => r[0]),
      db.select().from(holdingsTable),
      getRecentMemory(20).catch(() => ""),
    ]);

    const classMap = Object.fromEntries(watchlist.map(e => [e.symbol, e.assetClass]));
    const assetData = await fetchAllData(watchlist);
    if (assetData.length < 3) { console.warn("[scanner] Insufficient data"); return { ...FALLBACK_RESULT, regime }; }

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

    const risk         = (profile?.riskTolerance ?? "medium").toLowerCase();
    const targetReturn = profile?.targetReturnPct ?? 10;
    const capital      = profile?.totalCapital ?? 200;
    const strategyName = profile?.strategyType ?? "Balanced";
    const maxPosition  = Math.max(10, (totalPortfolio || capital) * 0.5);

    const riskDirective =
      risk === "extreme" || risk === "high"
        ? `EXTREME/HIGH risk: surface only high-conviction momentum plays. Crypto leverage up to 50x. Target: ${targetReturn}%/period.`
        : risk === "low"
          ? `LOW risk: prefer defensive, low-volatility assets. Avoid leverage >3x. Target: ${targetReturn}%/period.`
          : `MEDIUM risk: balanced approach. Leverage max 10x. Target: ${targetReturn}%/period.`;

    // ── Regime-aware scoring weights ─────────────────────────────────────────
    const regimeScoring = regime.regime === "CHOPPY"
      ? "REGIME=CHOPPY: DO NOT suggest new entries. Return WATCH or AVOID for all signals. Only manage existing positions."
      : regime.regime === "EXHAUSTION"
      ? "REGIME=EXHAUSTION: No new trend entries. Consider counter-trend only. Force partial profits on any existing winning position."
      : regime.regime === "VOLATILE"
      ? `REGIME=VOLATILE: ATR is ${(regime.atr / (regime.atrAvg30d || 1)).toFixed(1)}× above average. Halve position size. Widen SL to 2×ATR. Quick TP targets (≤1×ATR). Prefer limit orders only.`
      : regime.regime === "TRENDING_UP"
      ? "REGIME=TRENDING_UP: Allow longs, prefer market orders on breakouts. Wider TP (2×ATR). Trail aggressively after TP1."
      : "REGIME=TRENDING_DOWN: Allow shorts, prefer market orders on breakdowns. Wider TP (2×ATR). Trail aggressively after TP1.";

    const scoringWeights = regime.regime === "VOLATILE"
      ? [
          "Dynamic score weights for VOLATILE regime:",
          "  Direction clarity: 25pts | 4h structure: 25pts",
          "  Volume: 15pts | OI: 15pts | Funding: 10pts",
          "  Penalties: ATR extreme -10pts",
          "  Minimum score to recommend: 65",
        ].join("\n")
      : [
          "Dynamic score weights for TRENDING regime:",
          "  Regime alignment: 30pts | 4h trend direction: 25pts | 1h timing: 20pts",
          "  Volume expansion: 8pts | OI+price alignment: 7pts | Funding context: 5pts",
          "  Penalties: RSI >80 or <20: -5pts | Extended from EMA: -5pts",
          "  Signal freshness: -10pts if setup >2h old",
          "  Minimum score to recommend: 65 — only return signals scoring ≥65",
        ].join("\n");

    const systemContext = [
      "You are an elite quant trader. Respond with ONLY valid JSON — no markdown, no prose.",
      `Schema: {"opportunities":[{"symbol":"","assetClass":"","score":0-100,"recommendation":"STRONG BUY|BUY|WATCH|AVOID","reasoning":"","price":0,"dataTimestamp":"","direction":"long|short|neutral","conviction":"low|medium|high|strong_buy|strong_sell","entry":0,"stopLoss":0,"takeProfit":0,"atr":0,"tp1":0,"tp2":0,"leverage":1,"positionSizeUsd":0,"timeframeAlignment":"","orderType":"market|limit","limitPrice":0,"timeInForce":"IOC|GTC","orderReasoning":"","riskRewardRatio":0,"stopLossMethod":"swing_low|ATR|percent|support","stopLossReasoning":"","takeProfitReasoning":"","rrReasoning":"","fundingRateContext":"","openInterestContext":"","regimeAlignment":"","rejectReasons":[],"scoreBreakdown":{}}],"scanTimestamp":"","summary":""}`,
      "Rules: rank exactly 5 opportunities. 80-100=STRONG BUY(strong_buy), 60-79=BUY(high), 40-59=WATCH(medium), <40=AVOID.",
      "DIRECTION BIAS: NO bias toward long or short. Analyse objectively. Short positions are equally valid.",
      "FUNDING RATE (nonlinear): |rate|<0.03% neutral. 0.03-0.07% positive=mild long +3pts. >0.07% positive=crowded long -5pts. 0.03-0.07% negative=mild short +3pts. >0.07% negative=panic -5pts.",
      "OI CONTEXT: price up+OI up=new longs bullish +5pts. price up+OI down=short covering weaker +2pts. price down+OI up=new shorts bearish +5pts. price down+OI down=capitulation -3pts.",
      "Multi-timeframe: confirm trend across 1h, 4h, 1D. Higher conviction = more TF alignment.",
      "RSI <30 oversold (bullish bias), RSI >70 overbought (bearish bias). EMA20>EMA50=uptrend.",
      `User profile: Strategy=${strategyName}, Risk=${risk}, Target=${targetReturn}%/period, Capital=$${capital}.`,
      riskDirective,
      regimeScoring,
      scoringWeights,
      "ATR-based targets: TP1=entry±(ATR×1.0), TP2=entry±(ATR×2.0). SL=entry±(ATR×1.5). Include atr, tp1, tp2 in output.",
      "For LONGS: stopLoss below entry, takeProfit above entry, tp1 above entry, tp2 above tp1.",
      "For SHORTS: stopLoss above entry, takeProfit below entry, tp1 below entry, tp2 below tp1.",
      "riskRewardRatio: longs=(takeProfit-entry)/(entry-stopLoss); shorts=(entry-takeProfit)/(stopLoss-entry). Must be ≥1.5.",
      "Order type: MARKET(IOC) only on confirmed breakout with volume. LIMIT(GTC) when mid-range — set limitPrice at nearest support/resistance. NEVER market order mid-range.",
      `Max position: $${maxPosition.toFixed(0)} (50% of capital). Never exceed.`,
    ].join("\n");

    const prompt = [
      `Portfolio: $${totalPortfolio.toFixed(0)} total. Holdings: ${holdingSummary || "none"}.`,
      `Risk: ${profile?.riskTolerance ?? "high"}. Strategy: ${profile?.strategyType ?? "Momentum"}.`,
      `UTC: ${new Date().toISOString()}`,
      ``,
      `Market regime (BTC proxy): ${regime.regime}`,
      `ADX: ${regime.adx.toFixed(1)} | DI+: ${regime.diPlus.toFixed(1)} | DI-: ${regime.diMinus.toFixed(1)}`,
      `4h EMA20: $${regime.ema20_4h.toFixed(0)} | EMA50: $${regime.ema50_4h.toFixed(0)} | EMA200: $${regime.ema200_4h.toFixed(0)}`,
      `ATR: $${regime.atr.toFixed(0)} vs 30d avg: $${regime.atrAvg30d.toFixed(0)} (${regime.atr > 0 && regime.atrAvg30d > 0 ? (regime.atr / regime.atrAvg30d).toFixed(1) : "?"}×)`,
      `Regime note: ${regime.summary}`,
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
          opportunities: { type: "array" },
          scanTimestamp: { type: "string" },
          summary:       { type: "string" },
        },
        required: ["opportunities", "scanTimestamp", "summary"],
      },
      fallback: FALLBACK_RESULT,
    });

    if (!res.parseSuccess) return { ...FALLBACK_RESULT, regime };

    const result = res.data;
    result.scanTimestamp = new Date().toISOString();
    result.regime = regime;

    return result;
  });
}

export function scheduleScan(): void {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  setTimeout(() => {
    runScan().catch(e => console.error("[scanner] Initial scan failed:", e));
  }, 10_000);
  setInterval(() => {
    cache.invalidate(CacheKey.marketScan());
    runScan().catch(e => console.error("[scanner] Scheduled scan failed:", e));
  }, FOUR_HOURS);
  console.log("[scanner] Scheduled — runs every 4 h (first scan in 10 s)");
}
