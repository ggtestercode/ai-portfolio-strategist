import { llm }                      from "./llmRouter";
import { cache, TTL, CacheKey }     from "./contextCache";
import { getWatchlist, type WatchlistEntry } from "./watchlist";
import { fetchAssetData, type AssetData }    from "../data/marketData";
import { getKlines, getFundingRate, getOpenInterest, getTicker, getPositions as bybitGetPositions, type BybitKline, type BybitPosition } from "../brokers/bybit";
import { getRecentMemory, getPerformanceSummary } from "./tradeMemoryLib";
import { db, profileTable }                  from "@workspace/db";

export type Recommendation = "STRONG BUY" | "BUY" | "WATCH" | "AVOID";
export type Conviction     = "low" | "medium" | "high" | "strong_buy" | "strong_sell";
export type RegimeType     = "STRONG_TREND" | "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "CHOPPY" | "EXHAUSTION" | "VOLATILE";

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
  // New v2 fields
  setupType?:           "REJECTION" | "MOMENTUM" | "OVEREXTENDED" | "LIQUIDITY_SWEEP";
  setupQuality?:        "HIGH" | "MEDIUM" | "LOW";
  timing?:              "EARLY" | "MIDDLE" | "LATE";
  timingReasoning?:     string;
  whyNow?:              string;
  edgeType?:            "LIQUIDITY_TRAP" | "SQUEEZE_SETUP" | "RELATIVE_WEAKNESS" | "SWEEP_REVERSAL" | "TREND_CONTINUATION" | "MEAN_REVERSION";
  conflicts?:           string[];
  conflictResolution?:  "NO_CONFLICT" | "MINOR_REDUCED" | "MAJOR_SKIP";
  conflictReasoning?:   string;
  sweepDetected?:       boolean;
  squeezeDetected?:     boolean;
  relativeStrengthVsBtc?: number;
  rMultiple?:           number;
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
    } else if (adx > 35 && prevADX > adx * 1.05) {
      // ADX was higher → declining from a strong trend
      regime  = "EXHAUSTION";
      summary = `ADX ${adx.toFixed(1)} declining from peak — trend exhaustion`;
    } else if (adx > 35) {
      // Strong trend — direction from DI
      const dir = diPlus >= diMinus ? "bullish" : "bearish";
      regime  = "STRONG_TREND";
      summary = `ADX ${adx.toFixed(1)} — strong ${dir} trend | DI+ ${diPlus.toFixed(1)} DI- ${diMinus.toFixed(1)}`;
    } else if (adx > 25 && diPlus > diMinus) {
      regime  = "TRENDING_UP";
      summary = `ADX ${adx.toFixed(1)}, DI+ ${diPlus.toFixed(1)} > DI- ${diMinus.toFixed(1)}`;
    } else if (adx > 25 && diMinus > diPlus) {
      regime  = "TRENDING_DOWN";
      summary = `ADX ${adx.toFixed(1)}, DI- ${diMinus.toFixed(1)} > DI+ ${diPlus.toFixed(1)}`;
    } else if (adx >= 20) {
      regime  = "RANGING";
      summary = `ADX ${adx.toFixed(1)} — low trend strength, ranging`;
    } else {
      regime  = "CHOPPY";
      summary = `ADX ${adx.toFixed(1)} < 20 — directionless/choppy`;
    }

    console.log(`[regime] BTC 4h: ${regime} | ADX=${adx.toFixed(1)} DI+=${diPlus.toFixed(1)} DI-=${diMinus.toFixed(1)} ATR=${atr.toFixed(0)} (${atrRatio.toFixed(1)}× avg)`);
    return { regime, adx, diPlus, diMinus, ema20_4h, ema50_4h, ema200_4h, atr, atrAvg30d, summary };
  } catch (e) {
    console.warn("[regime] Detection failed:", (e as Error).message);
    return { regime: "CHOPPY", adx: 0, diPlus: 0, diMinus: 0, ema20_4h: 0, ema50_4h: 0, ema200_4h: 0, atr: 0, atrAvg30d: 0, summary: "Detection failed — defaulting to CHOPPY" };
  }
}

async function fetchMTFData(symbol: string): Promise<string> {
  const intervals: Array<[string, string, boolean]> = [
    ["1","1m",false], ["15","15m",false], ["60","1h",true], ["240","4h",true], ["D","1D",false],
  ];
  const parts: string[] = [];
  for (const [iv, label, withEma] of intervals) {
    try {
      const klines = await getKlines(symbol, iv, 50);
      const closes = klines.map(k => k.close);
      const rsi    = Math.round(calcRSI(closes, 14));
      const last   = closes[closes.length - 1]?.toFixed(2) ?? "N/A";
      if (withEma) {
        const ema20 = calcEMA(closes, 20).toFixed(2);
        const ema50 = calcEMA(closes, 50).toFixed(2);
        parts.push(`${label}:$${last} RSI${rsi} E20=$${ema20} E50=$${ema50}`);
      } else {
        parts.push(`${label}:$${last} RSI${rsi}`);
      }
    } catch { parts.push(`${label}:N/A`); }
  }
  return parts.join("|");
}

// ── Relative strength helpers ─────────────────────────────────────────────────

interface RSData {
  symbol: string;
  rs4h:   number;
  rs1d:   number;
  rs7d:   number;
  rsAvg:  number;
  bias:   "long" | "short" | "neutral";
}

async function fetchRelativeStrength(symbols: string[]): Promise<Map<string, RSData>> {
  // BTC baseline
  const btcK4h   = await getKlines("BTCUSDT", "240", 2).catch(() => [] as BybitKline[]);
  const btcK7d   = await getKlines("BTCUSDT", "D",   8).catch(() => [] as BybitKline[]);
  const btcTicker = await getTicker("BTCUSDT").catch(() => null);

  // change24h is already in %, e.g. 5.0 for +5%
  const btcH4 = btcK4h.length >= 2 ? (btcK4h[1]!.close - btcK4h[0]!.close) / btcK4h[0]!.close * 100 : 0;
  const btcD1 = btcTicker ? (btcTicker.change24h ?? 0) : 0;
  const btcD7 = btcK7d.length >= 2  ? (btcK7d[btcK7d.length-1]!.close - btcK7d[0]!.close) / btcK7d[0]!.close * 100 : 0;

  const result = new Map<string, RSData>();
  await Promise.allSettled(symbols.map(async sym => {
    try {
      const [ticker, k4h, k7d] = await Promise.all([
        getTicker(sym).catch(() => null),
        getKlines(sym, "240", 2).catch(() => [] as BybitKline[]),
        getKlines(sym, "D",   8).catch(() => [] as BybitKline[]),
      ]);
      const d1  = ticker ? (ticker.change24h ?? 0) : 0;
      const h4  = k4h.length >= 2 ? (k4h[1]!.close - k4h[0]!.close) / k4h[0]!.close * 100 : d1;
      const d7  = k7d.length >= 2  ? (k7d[k7d.length-1]!.close - k7d[0]!.close) / k7d[0]!.close * 100 : d1;
      const rs4h = h4 - btcH4;
      const rs1d = d1 - btcD1;
      const rs7d = d7 - btcD7;
      const rsAvg = (rs4h + rs1d + rs7d) / 3;
      result.set(sym, { symbol: sym, rs4h, rs1d, rs7d, rsAvg, bias: rsAvg < -5 ? "short" : rsAvg > 5 ? "long" : "neutral" });
    } catch { /* skip symbol */ }
  }));
  return result;
}

// ── Liquidity sweep detection ─────────────────────────────────────────────────

interface SweepResult {
  detected:        boolean;
  type:            "BULLISH_SWEEP" | "BEARISH_SWEEP" | "NONE";
  level:           number;
  sweepExtreme:    number;
  wickRatio:       number;
  volumeRatio:     number;
  reversalCandles: number;
  quality:         "HIGH" | "MEDIUM" | "LOW" | "NONE";
}

function detectLiquiditySweep(klines: BybitKline[]): SweepResult {
  const NONE: SweepResult = { detected: false, type: "NONE", level: 0, sweepExtreme: 0, wickRatio: 0, volumeRatio: 0, reversalCandles: 0, quality: "NONE" };
  if (klines.length < 20) return NONE;

  const recent   = klines.slice(-10);
  const volAvg20 = klines.slice(-20).reduce((s, k) => s + k.volume, 0) / 20;
  const lookback = recent.slice(0, 6);
  const support    = Math.min(...lookback.map(k => k.low));
  const resistance = Math.max(...lookback.map(k => k.high));

  for (let i = recent.length - 4; i < recent.length; i++) {
    const c         = recent[i]!;
    const body      = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const volRatio  = c.volume / (volAvg20 || 1);

    // BEARISH_SWEEP
    if (c.high > resistance && upperWick > body * 1.5 && c.close < resistance) {
      const quality: SweepResult["quality"] = volRatio >= 2 ? "HIGH" : volRatio >= 1.5 ? "MEDIUM" : "LOW";
      if (quality === "LOW") continue;
      return { detected: true, type: "BEARISH_SWEEP", level: resistance, sweepExtreme: c.high,
               wickRatio: upperWick / (body || 0.0001), volumeRatio: volRatio,
               reversalCandles: recent.length - i, quality };
    }
    // BULLISH_SWEEP
    if (c.low < support && lowerWick > body * 1.5 && c.close > support) {
      const quality: SweepResult["quality"] = volRatio >= 2 ? "HIGH" : volRatio >= 1.5 ? "MEDIUM" : "LOW";
      if (quality === "LOW") continue;
      return { detected: true, type: "BULLISH_SWEEP", level: support, sweepExtreme: c.low,
               wickRatio: lowerWick / (body || 0.0001), volumeRatio: volRatio,
               reversalCandles: recent.length - i, quality };
    }
  }
  return NONE;
}

// ── Squeeze detection ─────────────────────────────────────────────────────────

function detectSqueeze(
  fundingRate: number,
  price:       number,
  high50:      number,
  low50:       number,
): "LONG_SQUEEZE_SETUP" | "SHORT_SQUEEZE_SETUP" | "NONE" {
  const nearTop    = high50 > 0 && (high50 - price) / high50 < 0.03;
  const nearBottom = low50  > 0 && (price - low50)  / low50  < 0.03;
  if (fundingRate >  0.0007 && nearTop)    return "LONG_SQUEEZE_SETUP";
  if (fundingRate < -0.0007 && nearBottom) return "SHORT_SQUEEZE_SETUP";
  return "NONE";
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

export function getRegimeThreshold(regimeType: string | undefined): number {
  switch (regimeType) {
    case "RANGING":    return 70;
    case "CHOPPY":     return 80;
    case "VOLATILE":   return 75;
    case "EXHAUSTION": return 80;
    default:           return 65; // TRENDING_UP, TRENDING_DOWN, STRONG_TREND
  }
}

export async function runFreshScan(): Promise<ScanResult> {
  cache.invalidate(CacheKey.marketScan());
  return runScan();
}

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
    // ── Phase 0: Regime + basic data ─────────────────────────────────────────
    const regime = await detectMarketRegime();

    const [watchlist, profile, bybitPositions, tradeMemory, perfSummary] = await Promise.all([
      getWatchlist(),
      db.select().from(profileTable).limit(1).then(r => r[0]),
      bybitGetPositions().catch(() => [] as BybitPosition[]),
      getRecentMemory(20).catch(() => ""),
      getPerformanceSummary().catch(() => ""),
    ]);

    const classMap  = Object.fromEntries(watchlist.map(e => [e.symbol, e.assetClass]));
    const assetData = await fetchAllData(watchlist);
    if (assetData.length < 3) { console.warn("[scanner] Insufficient data"); return { ...FALLBACK_RESULT, regime }; }

    const bybitPosSummary = bybitPositions.length
      ? bybitPositions.map(p => `${p.symbol} ${p.side} size=${p.size} pnl=${p.pnlPct.toFixed(1)}%`).join(", ")
      : "none";

    // ── Phase 1: Call 1 — Haiku selects top 10 symbols by RS vs BTC ──────────
    const btcChange7d = Number(assetData.find(d => d.symbol === "BTCUSDT")?.change7d ?? 0);
    const cryptoData  = assetData.filter(d => classMap[d.symbol] === "Crypto");

    const rsRows = cryptoData.map(d => {
      const chg7d = Number(d.change7d);
      const rs    = (chg7d - btcChange7d).toFixed(1);
      const sign  = Number(rs) > 0 ? "+" : "";
      return `${d.symbol}|$${d.price.toFixed(2)}|7d${chg7d >= 0 ? "+" : ""}${chg7d.toFixed(1)}%|RS${sign}${rs}%|RSI${Number(d.rsi).toFixed(0)}`;
    });

    const rsCallResult = await llm.json<{ top10: string[] }>({
      taskType:      "market_scan_rs",
      systemContext: 'Select the top 10 crypto symbols for detailed signal generation. Respond ONLY with valid JSON: {"top10":["SYM1","SYM2",...10 items]}. Mix long candidates (positive RS vs BTC) and short candidates (negative RS). Skip RSI >85 or <15.',
      prompt: [
        `Regime: ${regime.regime} | ADX=${regime.adx.toFixed(1)} DI+=${regime.diPlus.toFixed(1)} DI-=${regime.diMinus.toFixed(1)}`,
        `BTC 7d: ${btcChange7d >= 0 ? "+" : ""}${btcChange7d.toFixed(1)}% | Positions: ${bybitPosSummary}`,
        ``,
        `Crypto (Symbol|Price|7d%|RS_vs_BTC|RSI):`,
        rsRows.join("\n"),
      ].join("\n"),
      schema:   { type: "object", properties: { top10: { type: "array", items: { type: "string" } } }, required: ["top10"] },
      fallback: { top10: cryptoData.slice(0, 10).map(d => d.symbol) },
    });

    const rawSelected = rsCallResult.data.top10.slice(0, 10).filter(s => classMap[s] !== undefined);
    const selectedSymbols = rawSelected.length >= 5
      ? rawSelected
      : cryptoData.slice(0, 10).map(d => d.symbol);
    console.log(`[scanner] Phase 1 → ${selectedSymbols.join(", ")}`);

    // ── Phase 2: Detailed data fetch for selected symbols (parallel) ──────────
    const mtfLines:     string[] = [];
    const fundingLines: string[] = [];
    const sweepMap     = new Map<string, SweepResult>();
    const squeezeMap   = new Map<string, string>();

    await Promise.allSettled(selectedSymbols.map(async sym => {
      try {
        const [mtf, fr, oi, klines] = await Promise.all([
          fetchMTFData(sym),
          getFundingRate(sym).catch(() => ({ rate: 0, nextFundingTime: 0 })),
          getOpenInterest(sym).catch(() => 0),
          getKlines(sym, "60", 25).catch(() => [] as BybitKline[]),
        ]);
        const rSign = fr.rate >= 0 ? "+" : "";
        mtfLines.push(`${sym} MTF: ${mtf}`);
        fundingLines.push(`${sym} fundingRate=${rSign}${(fr.rate * 100).toFixed(4)}% OI=${oi > 1e9 ? `${(oi/1e9).toFixed(2)}B` : oi > 1e6 ? `${(oi/1e6).toFixed(1)}M` : oi.toFixed(0)}`);
        sweepMap.set(sym, detectLiquiditySweep(klines));
        const high50 = klines.length > 0 ? Math.max(...klines.map(k => k.high)) : 0;
        const low50  = klines.length > 0 ? Math.min(...klines.map(k => k.low))  : 0;
        const price  = klines.length > 0 ? klines[klines.length - 1]!.close : 0;
        squeezeMap.set(sym, detectSqueeze(fr.rate, price, high50, low50));
      } catch { /* skip */ }
    }));

    const rsMap = await fetchRelativeStrength(selectedSymbols).catch(() => new Map<string, RSData>());

    const rsLines = selectedSymbols.map(sym => {
      const rs = rsMap.get(sym);
      if (!rs) return null;
      const sign = rs.rsAvg > 0 ? "+" : "";
      const tag  = rs.bias === "short" ? "→ weak, short bias" : rs.bias === "long" ? "→ strong, long bias" : "→ neutral";
      return `  ${sym}: ${sign}${rs.rsAvg.toFixed(1)}% vs BTC ${tag}`;
    }).filter(Boolean);

    const rsContext = rsLines.length
      ? `Relative strength vs BTC (avg 4h/1D/7D):\n${rsLines.join("\n")}`
      : "";

    const sweepLines: string[] = [];
    for (const [sym, sw] of sweepMap) {
      if (!sw.detected) continue;
      sweepLines.push(
        `Liquidity sweep detected on ${sym}: ${sw.type}\n` +
        `  Level: $${sw.level.toFixed(4)} | Sweep extreme: $${sw.sweepExtreme.toFixed(4)}\n` +
        `  Wick: ${sw.wickRatio.toFixed(1)}× body | Volume: ${sw.volumeRatio.toFixed(1)}× avg\n` +
        `  Reversal: ${sw.reversalCandles} candle(s) | Quality: ${sw.quality}`
      );
    }
    const squeezeLines: string[] = [];
    for (const [sym, sq] of squeezeMap) {
      if (sq === "NONE") continue;
      squeezeLines.push(`Squeeze setup on ${sym}: ${sq}`);
    }
    const sweepContext   = sweepLines.join("\n\n");
    const squeezeContext = squeezeLines.join("\n");

    // Table: selected crypto + all non-crypto for context
    const tableData = assetData.filter(d => selectedSymbols.includes(d.symbol) || classMap[d.symbol] !== "Crypto");
    const tableRows = tableData.map(d => formatRow(d, classMap[d.symbol] ?? "Unknown"));

    // ── Phase 2: Call 2 — Sonnet generates signals for top 10 only ───────────
    const risk         = (profile?.riskTolerance ?? "medium").toLowerCase();
    const targetReturn = profile?.targetReturnPct ?? 10;
    const capital      = profile?.totalCapital ?? 200;
    const strategyName = profile?.strategyType ?? "Balanced";
    const maxPosition  = Math.max(10, capital * 0.5);

    const riskDirective =
      risk === "extreme" || risk === "high"
        ? `EXTREME/HIGH risk: surface only high-conviction momentum plays. Crypto leverage up to 50x. Target: ${targetReturn}%/period.`
        : risk === "low"
          ? `LOW risk: prefer defensive, low-volatility assets. Avoid leverage >3x. Target: ${targetReturn}%/period.`
          : `MEDIUM risk: balanced approach. Leverage max 10x. Target: ${targetReturn}%/period.`;

    const strongTrendDir = regime.diPlus >= regime.diMinus ? "bullish" : "bearish";
    const regimeScoring =
      regime.regime === "CHOPPY"
        ? "REGIME=CHOPPY: DO NOT suggest new entries. Return WATCH or AVOID for all signals."
      : regime.regime === "RANGING"
        ? "REGIME=RANGING: Price oscillating between support and resistance. ONLY enter at range boundaries — SHORT when price is within 3% of the 50-period high (resistance), LONG when price is within 3% of the 50-period low (support). DO NOT enter mid-range. Include the 50-period high as entry/resistance context for shorts and 50-period low for longs. Use limit orders at or just inside the boundary. SL beyond the boundary (short: above 50-period high, long: below 50-period low). Target the opposite boundary for TP. Small size, tight SL. Both directions allowed — pick whichever boundary price is near."
      : regime.regime === "EXHAUSTION"
        ? "REGIME=EXHAUSTION: No new trend entries. Counter-trend scalps only. Force partial profits on existing winning positions."
      : regime.regime === "VOLATILE"
        ? `REGIME=VOLATILE: ATR is ${(regime.atr / (regime.atrAvg30d || 1)).toFixed(1)}× above average. Halve position size. Widen SL to 2×ATR. Quick TP (≤1×ATR). Limit orders only.`
      : regime.regime === "STRONG_TREND"
        ? `REGIME=STRONG_TREND (${strongTrendDir}, ADX=${regime.adx.toFixed(0)}): Very strong trend. ${strongTrendDir === "bullish" ? "Prefer longs but identify coins showing individual bearish divergence for short opportunities." : "Prefer shorts but identify coins showing individual bullish divergence for long opportunities."} Allow both directions — check each coin's own momentum.`
      : regime.regime === "TRENDING_UP"
        ? "REGIME=TRENDING_UP: Prefer longs on breakouts. Shorts allowed on coins showing bearish divergence or weakness (price rejecting resistance, failing to follow BTC higher). Both directions valid — scan each coin individually."
        : "REGIME=TRENDING_DOWN: Prefer shorts on breakdowns. Longs allowed on coins showing bullish divergence or holding support (failing to follow BTC lower). Both directions valid — scan each coin individually.";

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
      `Schema: {"opportunities":[{"symbol":"ETHUSDT","assetClass":"Crypto","score":75,"recommendation":"BUY","reasoning":"1-sentence edge","price":0,"dataTimestamp":"","direction":"long","conviction":"high","entry":0,"stopLoss":0,"takeProfit":0,"atr":0,"tp1":0,"tp2":0,"leverage":5,"positionSizeUsd":0,"timeframeAlignment":"1h+4h","orderType":"limit","limitPrice":0,"timeInForce":"GTC","riskRewardRatio":2.0,"stopLossMethod":"swing_low","setupType":"MOMENTUM","setupQuality":"HIGH","timing":"EARLY","whyNow":"specific named edge","edgeType":"TREND_CONTINUATION","conflicts":[],"conflictResolution":"NO_CONFLICT","sweepDetected":false,"squeezeDetected":false,"relativeStrengthVsBtc":3.5}],"scanTimestamp":"ISO","summary":""}`,
      `Rank exactly 5. LONGS: ≥80=STRONG BUY(strong_buy), 60-79=BUY(high). SHORTS: ≥80=STRONG SELL(strong_sell), 60-79=SELL(high). 40-59=WATCH, <40=AVOID. Include ≥1 short per scan — look for coins rejecting resistance or lagging BTC.`,
      `Funding: |rate|<0.03% neutral; 0.03-0.07% directional +3pts; >0.07% crowded -5pts. OI up+price up=bullish +5pts; OI down+price up=weak +2pts; OI up+price down=bearish +5pts; OI down+price down=-3pts.`,
      riskDirective,
      regimeScoring,
      scoringWeights,
      `ATR targets: TP1=entry±ATR, TP2=entry±2ATR, SL=entry±1.5ATR. RR≥1.5. LONGS: SL<entry, TPs above. SHORTS: SL>entry, TPs below.`,
      `Orders: LIMIT(GTC) mid-range at nearest S/R; MARKET(IOC) only on confirmed volume breakout. Max position: $${maxPosition.toFixed(0)}.`,
      `setupType=REJECTION|MOMENTUM|OVEREXTENDED|LIQUIDITY_SWEEP. setupQuality=HIGH|MEDIUM|LOW. timing=EARLY(fresh)|MIDDLE(1-2ATR)|LATE(3+ATR or RSI extreme) — skip LATE unless LIQUIDITY_SWEEP.`,
      `WHY NOW: name a specific edge — e.g. 'Funding +0.09% longs trapped at $96.5 rejection'. Generic → direction=neutral.`,
      `RS data: >+5% vs BTC=long candidate +5pts; <-5%=short candidate +5pts; set relativeStrengthVsBtc. CONFLICTS: MAJOR_SKIP→direction=neutral. Sweep→sweepDetected=true+setupType=LIQUIDITY_SWEEP. Squeeze→squeezeDetected=true.`,
    ].join("\n");

    const prompt = [
      `Bybit live positions: ${bybitPosSummary}`,
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
      rsContext ? `\n${rsContext}\n` : "",
      sweepContext   ? `\n${sweepContext}` : "",
      squeezeContext ? `\nSqueeze setups:\n${squeezeContext}` : "",
      `Market snapshot — top 10 selected (Symbol|Class|Price|7d%|30d%|RSI|Volume):`,
      tableRows.join("\n"),
      ``,
      tradeMemory ? `Trade memory (last reflections):\n${tradeMemory}` : "",
      perfSummary ? `\n${perfSummary}` : "",
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
