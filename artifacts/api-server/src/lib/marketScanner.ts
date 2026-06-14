import { llm }                      from "./llmRouter";
import { cache, TTL, CacheKey }     from "./contextCache";
import { getWatchlist, type WatchlistEntry } from "./watchlist";
import { fetchAssetData, type AssetData }    from "../data/marketData";
import { getKlines, getFundingRate, getOpenInterest, getTicker, getPositions as bybitGetPositions, getOrderbook, getFundingHistory, getOrders as bybitGetOrders, type BybitKline, type BybitPosition } from "../brokers/bybit";
import { getRecentMemory, getPerformanceSummary, getActiveRules } from "./tradeMemoryLib";
import { db, profileTable, botStateTable }    from "@workspace/db";
import { sql }                               from "drizzle-orm";

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
  rewardRiskRatio?:     number;
  tp1ClosePercent?:     number;
  tp2ClosePercent?:     number;
  stopLossMethod?:      string;
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
  blowoffSuspected?:    boolean;  // 4h blowoff pattern detected at entry (informational only)
  symRegime?:           RegimeType; // per-symbol 4h regime at entry (NOT BTC proxy) — used for rule selectivity
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

// ── 4h Blowoff / Exhaustion detection ────────────────────────────────────────
// Scans the last ~5 COMPLETED 4h candles (skips [length-1] which is in-progress)
// and finds the most blowoff-like one.  Returns its metrics plus a boolean flag
// when all four thresholds are simultaneously met.
//
// Thresholds calibrated from XMR blowoff (flags) vs ATOM healthy trend (clean):
//   range/ATR ≥ 2.5   XMR: 3.55×  ATOM worst: 1.32×
//   close_pos ≤ 0.30  XMR: 0.097  ATOM: never <0.17 on a large candle
//   vol/avg20 ≥ 3.0   XMR: 5.51×  ATOM worst: 2.69×
//   run20     ≥ 15%   XMR: 27.4%  ATOM worst: 15.7% (fails other gates)
//
// flag is INFORMATIONAL — no suppression, no score change, no regime relabel.

interface BlowoffMetrics {
  rangeAtr:  number;  // (high − low) / ATR14
  closePos:  number;  // (close − low) / (high − low)  [0 = closed at low]
  volRatio:  number;  // candle vol / mean(prev 20 vols)
  run20:     number;  // (close − min_low_prev_20) / min_low_prev_20  [%]
  suspected: boolean; // true when all four thresholds are simultaneously met
}

function detectBlowoff(symK4h: BybitKline[], atr: number): BlowoffMetrics | null {
  // Need ≥25 candles: 20 for vol/run lookback + a few completed before in-progress
  if (symK4h.length < 25 || atr <= 0) return null;

  const n         = symK4h.length;
  const scanEnd   = n - 2;                    // [n-1] is in-progress — never measure it
  const scanStart = Math.max(21, n - 6);      // up to 5 completed candles, each needs 20 prior

  let flagged: BlowoffMetrics | null = null;  // first candle that passes all 4 gates
  let biggest: BlowoffMetrics | null = null;  // candle with highest range/ATR

  for (let i = scanEnd; i >= scanStart; i--) {
    const c   = symK4h[i]!;
    const rng = c.high - c.low;
    if (rng <= 0) continue;

    const rangeAtr = rng / atr;
    const closePos = (c.close - c.low) / rng;

    // Use the 20 candles immediately before this one for the vol average and run base.
    // slice(i-20, i) is exactly the completed window without the spike candle itself.
    const prior  = symK4h.slice(i - 20, i);
    const avgVol = prior.reduce((s, k) => s + k.volume, 0) / prior.length;
    const volRatio = avgVol > 0 ? c.volume / avgVol : 0;

    const minLow = Math.min(...prior.map(k => k.low));
    const run20  = minLow > 0 ? (c.close - minLow) / minLow * 100 : 0;

    const suspected = rangeAtr >= 2.5 && closePos <= 0.30 && volRatio >= 3.0 && run20 >= 15;
    const m: BlowoffMetrics = { rangeAtr, closePos, volRatio, run20, suspected };

    if (suspected && !flagged) flagged = m;
    if (!biggest || rangeAtr > biggest.rangeAtr) biggest = m;
  }

  // Show the flagged candle's metrics when a blowoff is detected; otherwise the
  // most extreme recent candle (useful context even when thresholds aren't met).
  return flagged ?? biggest;
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

async function fetchMTFData(symbol: string): Promise<{ summary: string; klines1h: BybitKline[]; klines15m: BybitKline[]; klines4h: BybitKline[] }> {
  const intervals: Array<[string, string, boolean]> = [
    ["1","1m",false], ["15","15m",false], ["60","1h",true], ["240","4h",true], ["D","1D",false],
  ];
  const parts: string[] = [];
  let klines1h:  BybitKline[] = [];
  let klines15m: BybitKline[] = [];
  let klines4h:  BybitKline[] = [];
  for (const [iv, label, withEma] of intervals) {
    try {
      // 4h uses 60 candles (matches BTC regime fetch) — sufficient for ADX-14 warm-up
      const klines = await getKlines(symbol, iv, iv === "240" ? 60 : 50);
      if (iv === "60")  klines1h  = klines;
      if (iv === "15")  klines15m = klines;
      if (iv === "240") klines4h  = klines;
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
  return { summary: parts.join("|"), klines1h, klines15m, klines4h };
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
  scanFailed?:    boolean;  // true when LLM output was truncated/unparseable — NOT a genuine no-signal scan
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

// Classify a symbol's own 4h regime from its klines — same ADX thresholds as detectMarketRegime.
// Also computes the symbol's own 4h ATR so trade records store the correct per-symbol value,
// not the BTC regime ATR that is prominently displayed in the scan prompt.
function classifySymbolRegime(klines: BybitKline[]): { regime: RegimeType; adx: number; diPlus: number; diMinus: number; atr: number } {
  if (klines.length < 29) return { regime: "CHOPPY", adx: 0, diPlus: 0, diMinus: 0, atr: 0 };
  const { adx, diPlus, diMinus } = calcADX(klines, 14);
  const atr = calcATR(klines, 14);
  let regime: RegimeType;
  if      (adx > 35 && diPlus >= diMinus) regime = "STRONG_TREND";
  else if (adx > 35)                      regime = "TRENDING_DOWN";
  else if (adx > 25 && diPlus > diMinus)  regime = "TRENDING_UP";
  else if (adx > 25)                      regime = "TRENDING_DOWN";
  else if (adx >= 20)                     regime = "RANGING";
  else                                    regime = "CHOPPY";
  return { regime, adx, diPlus, diMinus, atr };
}

// Short TP cap text for a given regime (used in per-symbol regime prompt lines).
function tpCapShort(r: RegimeType): string {
  switch (r) {
    case "STRONG_TREND":
    case "TRENDING_UP":   return "TP1 2–3%, TP2 4–8%";
    case "TRENDING_DOWN": return "longs hard-blocked; shorts TP1 2–3%, TP2 4–6%";
    case "RANGING":       return "TP1 max 1.5%, TP2 max 2.5% — NOTE: no clean RANGING SL data yet; same R:R math as CHOPPY applies — verify first RANGING trade clears R:R 1.1 at realistic structural SL.";
    case "EXHAUSTION":    return "TP1 max 2.0%, TP2 max 3.5%";
    // CHOPPY: TP1 capped at 1.5% (evidenced — SOL moved 1.22%, 2.5% TP1 was unreachable; first partial must be reachable).
    // TP2 at 3.5%: blended reward = 0.30×1.5 + 0.70×3.5 = 2.9%; max SL for R:R≥1.1 = 2.64% — clears realistic CHOPPY SLs (2.3–3%).
    // TP2 was briefly 2.5% (made CHOPPY un-enterable: max SL only 2.0%, 8/9 historical trades failed gate).
    // Protection from riding reversals comes from the 0.8% early-breakeven trigger (Option B, cronScanner),
    // NOT from a tight TP2. TP2 only needs to clear R:R at realistic SLs.
    case "CHOPPY":        return "TP1 max 1.5%, TP2 max 3.5% — CHOPPY compresses moves to ~1–2% before reversal; TP1 at nearest structural level within cap. TP2 at 3.5% keeps R:R viable (blended 2.9% vs typical 2.3–3% SL). Reversal protection comes from the 0.8% early-breakeven trigger, not a tight TP2.";
    default:              return "TP1 within 1–3× ATR";
  }
}

export async function runFreshScan(): Promise<ScanResult> {
  cache.invalidate(CacheKey.marketScan());
  return runScan();
}

async function fetchBatch(entries: Array<{ symbol: string; assetClass: string }>): Promise<AssetData[]> {
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

function fmtP(p: number): string {
  if (p >= 10000) return p.toFixed(1);
  if (p >= 100)   return p.toFixed(2);
  if (p >= 1)     return p.toFixed(4);
  return p.toFixed(6);
}

function fmtCandle(k: BybitKline): string {
  return `${fmtP(k.open)},${fmtP(k.high)},${fmtP(k.low)},${fmtP(k.close)},${Math.round(k.volume)}`;
}

// ── Phase 2 helper: fetch data + LLM signal generation for given symbols ─────

async function runPhase2(
  selectedSymbols: string[],
  classMap:        Record<string, string>,
  allAssetData:    AssetData[],
  regime:          MarketRegime,
  bybitPosSummary: string,
  profile:         { riskTolerance?: string; targetReturnPct?: number; totalCapital?: number; strategyType?: string } | null,
  tradeMemory:     string,
  perfSummary:     string,
  activeRules:     Awaited<ReturnType<typeof getActiveRules>>,
  leverage:        number,
): Promise<{ opportunities: ScanOpportunity[]; scanFailed: boolean }> {
  // ── Phase 2: Detailed data fetch for selected symbols (parallel) ──────────
  const mtfLines:        string[] = [];
  const fundingLines:    string[] = [];
  const liqLines:        string[] = [];
  const candle1hLines:   string[] = [];
  const candle15mLines:  string[] = [];
  const volRatioLines:   string[] = [];
  const orderbookLines:  string[] = [];
  const fundingHistLines:string[] = [];
  const recentExitLines: string[] = [];
  const pendingLines:    string[] = [];
  const sweepMap     = new Map<string, SweepResult>();
  const squeezeMap   = new Map<string, string>();
  const symRegimeMap = new Map<string, { regime: RegimeType; adx: number; diPlus: number; diMinus: number; atr: number }>();
  const blowoffMap   = new Map<string, BlowoffMetrics>();

  // ── Recent exits (last 24h) per selected symbol ───────────────────────────
  try {
    type RecentExitRow = { symbol: string; exit_at: string; exit_price: string; pnl: string; exit_method: string | null };
    // Use IN(...) with individual sql params — ANY($1) with a JS array fails on Neon serverless
    const symList     = sql.join(selectedSymbols.map(s => sql`${s}`), sql`,`);
    const recentExits = await db.execute<RecentExitRow>(sql`
      SELECT DISTINCT ON (tl.symbol)
        tl.symbol,
        tl.exit_at,
        tl.exit_price,
        tl.pnl,
        COALESCE(tm.exit_method, 'unknown') AS exit_method
      FROM trade_log tl
      LEFT JOIN trade_memory tm
        ON tm.symbol = tl.symbol
        AND tm.action = 'TRADE_CLOSE'
        AND tm.created_at >= tl.exit_at
        AND tm.created_at <= tl.exit_at + INTERVAL '4 hours'
      WHERE tl.exit_at >= NOW() - INTERVAL '24 hours'
        AND tl.symbol IN (${symList})
      ORDER BY tl.symbol, tl.exit_at DESC
    `);
    for (const row of recentExits.rows) {
      const hoursAgo = Math.round((Date.now() - new Date(row.exit_at).getTime()) / 3_600_000);
      const price    = parseFloat(row.exit_price ?? "0");
      const pnl      = parseFloat(row.pnl ?? "0");
      const method   = row.exit_method ?? "unknown";
      let label: string;
      if      (method === "sl_hit")               label = "sl_hit";
      else if (method.startsWith("tp"))           label = method;
      else if (method === "review")               label = "review close";
      else if (method === "profit_protection")    label = "profit protection close";
      else                                        label = pnl > 0 ? "closed profitable" : "closed at loss";
      recentExitLines.push(`${row.symbol} Recent: ${label} ${hoursAgo}h ago at $${price}`);
    }
    if (recentExitLines.length) console.log(`[scanner] Recent exits injected: ${recentExitLines.join(" | ")}`);
  } catch (e) {
    console.warn("[scanner] Recent exits query failed:", String(e));
  }

  // ── Pending limit orders — fetch once, inject per matching symbol ────────────
  const pendingMap = new Map<string, { side: string; price: number; qty: number; hoursAgo: number }>();
  try {
    const openOrders = await bybitGetOrders().catch(() => []);
    for (const o of openOrders) {
      const hoursAgo = Math.round((Date.now() - new Date(o.placedAt).getTime()) / 3_600_000);
      pendingMap.set(o.symbol, { side: o.side, price: o.price, qty: o.qty, hoursAgo });
    }
  } catch { /* skip — non-critical */ }

  await Promise.allSettled(selectedSymbols.map(async sym => {
    try {
      const [mtfResult, fr, oi, klines, ob, fundingHist] = await Promise.all([
        fetchMTFData(sym),
        getFundingRate(sym).catch(() => ({ rate: 0, nextFundingTime: 0 })),
        getOpenInterest(sym).catch(() => 0),
        getKlines(sym, "60", 25).catch(() => [] as BybitKline[]),
        getOrderbook(sym, 50).catch(() => ({ bids: [] as Array<[number,number]>, asks: [] as Array<[number,number]> })),
        getFundingHistory(sym, 24).catch(() => [] as number[]),
      ]);
      const { summary: mtf, klines1h, klines15m, klines4h: symK4h } = mtfResult;
      if (symK4h.length >= 29) {
        const symR = classifySymbolRegime(symK4h);
        symRegimeMap.set(sym, symR);
        // Detect 4h blowoff — reads ATR already computed by classifySymbolRegime,
        // scans last 5 completed candles (skips [length-1] which is still forming).
        const bf = detectBlowoff(symK4h, symR.atr);
        if (bf) blowoffMap.set(sym, bf);
      }
      const rSign = fr.rate >= 0 ? "+" : "";
      const price  = klines.length > 0 ? klines[klines.length - 1]!.close : 0;
      mtfLines.push(`${sym} MTF: ${mtf}`);
      fundingLines.push(`${sym} fundingRate=${rSign}${(fr.rate * 100).toFixed(4)}% OI=${oi > 1e9 ? `${(oi/1e9).toFixed(2)}B` : oi > 1e6 ? `${(oi/1e6).toFixed(1)}M` : oi.toFixed(0)}`);
      if (price > 0) liqLines.push(`${sym} liq@${leverage}x: long=$${(price * (1 - 1/leverage + 0.005)).toFixed(4)} short=$${(price * (1 + 1/leverage - 0.005)).toFixed(4)}`);
      if (klines1h.length  > 0) candle1hLines.push(`${sym} 1h candles (O,H,L,C,V): ${klines1h.slice(-50).map(fmtCandle).join(" | ")}`);
      if (klines15m.length > 0) candle15mLines.push(`${sym} 15m candles (O,H,L,C,V): ${klines15m.slice(-50).map(fmtCandle).join(" | ")}`);
      // Volume ratio vs 20-candle avg (excluding current forming candle)
      if (klines1h.length >= 21 && klines15m.length >= 21) {
        const avgVol1h      = klines1h.slice(-21, -1).reduce((s, k) => s + k.volume, 0) / 20;
        const vol1hRatio    = avgVol1h > 0 ? klines1h[klines1h.length - 1]!.volume / avgVol1h : 0;
        const avgVol15m     = klines15m.slice(-21, -1).reduce((s, k) => s + k.volume, 0) / 20;
        const vol15mRatio   = avgVol15m > 0 ? klines15m[klines15m.length - 1]!.volume / avgVol15m : 0;
        const c2_1h = klines1h[klines1h.length - 2];
        const c1_1h = klines1h[klines1h.length - 1];
        const climax1h   = c2_1h && c2_1h.close < c2_1h.open && avgVol1h > 0 && c2_1h.volume / avgVol1h >= 4.0;
        const recovery1h = c1_1h && c1_1h.close > c1_1h.open && avgVol1h > 0 && c1_1h.volume / avgVol1h >= 1.5;
        const flag1h     = climax1h && recovery1h ? " [BEARISH_CLIMAX_RECOVERY]" : "";
        const c2_15m = klines15m[klines15m.length - 2];
        const c1_15m = klines15m[klines15m.length - 1];
        const climax15m   = c2_15m && c2_15m.close < c2_15m.open && avgVol15m > 0 && c2_15m.volume / avgVol15m >= 4.0;
        const recovery15m = c1_15m && c1_15m.close > c1_15m.open && avgVol15m > 0 && c1_15m.volume / avgVol15m >= 1.5;
        const flag15m     = climax15m && recovery15m ? " [BEARISH_CLIMAX_RECOVERY]" : "";
        volRatioLines.push(`${sym} VOL: 1h last=${vol1hRatio.toFixed(1)}x avg20${flag1h} | 15m last=${vol15mRatio.toFixed(1)}x avg20${flag15m}`);
      }
      if (ob.bids.length > 0 && ob.asks.length > 0) {
        const fmtLevel = ([p, s]: [number, number]) => `${fmtP(p)}×${Math.round(s)}`;
        orderbookLines.push(`${sym} Bids: ${ob.bids.slice(0,50).map(fmtLevel).join(",")} Asks: ${ob.asks.slice(0,50).map(fmtLevel).join(",")}`);
      }
      if (fundingHist.length > 0) {
        const fmtRate = (r: number) => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(4)}%`;
        fundingHistLines.push(`${sym} funding hist (oldest→newest): ${fundingHist.map(fmtRate).join(",")}`);
      }
      sweepMap.set(sym, detectLiquiditySweep(klines));
      const high50 = klines.length > 0 ? Math.max(...klines.map(k => k.high)) : 0;
      const low50  = klines.length > 0 ? Math.min(...klines.map(k => k.low))  : 0;
      squeezeMap.set(sym, detectSqueeze(fr.rate, price, high50, low50));
      const pending = pendingMap.get(sym);
      if (pending) {
        const dir = pending.side === "Buy" ? "BUY" : "SELL";
        pendingLines.push(`${sym} Pending: ${dir} limit $${pending.price} qty=${pending.qty} placed ${pending.hoursAgo}h ago — unfilled`);
      }
    } catch { /* skip */ }
  }));

  // BTC is "directional" when it has a clear trend: STRONG_TREND / TRENDING_UP / TRENDING_DOWN.
  // In all other cases (CHOPPY, RANGING, EXHAUSTION, VOLATILE) each symbol uses its own regime for TP caps.
  const btcIsDirectional = ["STRONG_TREND", "TRENDING_UP", "TRENDING_DOWN"].includes(regime.regime);

  // Retry 4h kline fetch for any symbol whose initial fetch was silently rate-limited.
  // Runs sequentially with stagger to stay within Bybit's per-key rate limit.
  const missingRegime = selectedSymbols.filter(s => !symRegimeMap.has(s));
  if (missingRegime.length > 0) {
    for (const sym of missingRegime) {
      try {
        const k4h = await getKlines(sym, "240", 60);
        if (k4h.length >= 29) symRegimeMap.set(sym, classifySymbolRegime(k4h));
      } catch { /* rate limit still active — skip */ }
      await new Promise(r => setTimeout(r, 200)); // 200ms stagger between retries
    }
  }

  for (const sym of selectedSymbols) {
    const r  = symRegimeMap.get(sym);
    const bf = blowoffMap.get(sym);
    if (r) {
      const src      = btcIsDirectional ? `BTC (${regime.regime})` : `own (${r.regime})`;
      const bfSuffix = bf
        ? ` 4h_spike:range=${bf.rangeAtr.toFixed(2)}xATR close=${bf.closePos.toFixed(2)} vol=${bf.volRatio.toFixed(2)}xavg run20=${bf.run20 >= 0 ? "+" : ""}${bf.run20.toFixed(0)}%${bf.suspected ? " ⚠️BLOWOFF_SUSPECTED" : ""}`
        : "";
      console.log(`[regime] ${sym}: own=${r.regime} ADX=${r.adx.toFixed(1)} DI+=${r.diPlus.toFixed(1)} DI-=${r.diMinus.toFixed(1)} ATR=${r.atr.toFixed(2)} → caps from ${src}${bfSuffix}`);
    }
  }

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
  const tableData = allAssetData.filter(d => selectedSymbols.includes(d.symbol) || classMap[d.symbol] !== "Crypto");
  const tableRows = tableData.map(d => formatRow(d, classMap[d.symbol] ?? "Unknown"));

  // ── Phase 2: Call 2 — Sonnet generates signals for top 10 only ───────────
  const risk         = (profile?.riskTolerance ?? "medium").toLowerCase();
  const targetReturn = profile?.targetReturnPct ?? 10;
  const capital      = profile?.totalCapital ?? 200;
  const maxPosition  = Math.max(10, capital * 0.5);

  const riskDirective =
    risk === "extreme" || risk === "high"
      ? `EXTREME/HIGH risk: surface only high-conviction momentum plays. Crypto leverage up to 50x. Target: ${targetReturn}%/period.`
      : risk === "low"
        ? `LOW risk: prefer defensive, low-volatility assets. Avoid leverage >3x. Target: ${targetReturn}%/period.`
        : `MEDIUM risk: balanced approach. Leverage max 10x. Target: ${targetReturn}%/period.`;

  // regimeScoring and scoringWeights removed — Claude receives regime label and decides freely
  // No per-regime entry instructions, no point allocations, no minimum score threshold

  const signalTruthTable = [
    "SIGNAL TRUTH TABLE — direction-aware (apply before scoring any opportunity):",
    "  Price at support       → LONG: valid entry zone | SHORT: risky, expect bounce",
    "  Price at resistance    → LONG: risky, expect rejection | SHORT: valid entry zone",
    "  RSI > 70               → LONG: overbought caution (-5pts) | SHORT: still bearish pressure",
    "  RSI < 30               → LONG: still bullish pressure | SHORT: oversold caution (-5pts)",
    "  Funding rate positive  → LONG: longs crowded, squeeze risk (-3pts) | SHORT: being paid, +3pts",
    "  Funding rate negative  → LONG: being paid, +3pts | SHORT: shorts crowded, squeeze risk (-3pts)",
    "  OI rising + price up   → LONG: bullish confirmation +5pts | SHORT: pain trade, -3pts",
    "  OI rising + price down → LONG: distribution, -3pts | SHORT: genuine selling +5pts",
    "  BTC green              → LONG: tailwind | SHORT: headwind (-3pts if strong)",
    "  BTC red                → LONG: headwind (-3pts if strong) | SHORT: tailwind",
    "NEVER apply LONG signal interpretation to SHORT setups or vice versa.",
  ].join("\n");

  // Static prefix — no live data embedded; cached by llmRouter (cache: true in TASK_CONFIG)
  const systemContext = [
    "You are an elite quant trader. Respond with ONLY valid JSON — no markdown, no prose, no preamble. Start your response with { immediately.",
    signalTruthTable,
    `Schema: {"opportunities":[{"symbol":"ETHUSDT","assetClass":"Crypto","score":75,"recommendation":"BUY","reasoning":"RSI 68 rejection at $3.2k resistance, funding +0.08%","price":0,"dataTimestamp":"","direction":"long","conviction":"high","entry":0,"stopLoss":0,"takeProfit":0,"atr":0,"tp1":0,"tp2":0,"leverage":5,"positionSizeUsd":0,"timeframeAlignment":"1h+4h","orderType":"limit","limitPrice":0,"timeInForce":"GTC","rewardRiskRatio":2.0,"tp1ClosePercent":30,"tp2ClosePercent":100,"stopLossMethod":"swing_low","setupType":"MOMENTUM","setupQuality":"HIGH","timing":"EARLY","whyNow":"funding +0.08% longs crowded at resistance","edgeType":"TREND_CONTINUATION","conflicts":[],"conflictResolution":"NO_CONFLICT","sweepDetected":false,"squeezeDetected":false,"relativeStrengthVsBtc":3.5}],"scanTimestamp":"ISO","summary":""}`,
    `BREVITY RULE: reasoning must be ≤ 100 characters (one phrase, not a sentence). whyNow must be ≤ 120 characters (one specific edge). Do not elaborate — short and specific beats long and generic. Verbose fields cause output truncation and lose all signals.`,
    `rewardRiskRatio: reward divided by risk. Reward = weighted blend: (tp1 close fraction × distance to TP1) + (remaining fraction × distance to TP2), divided by distance from entry to SL. This must match how the gate evaluates R:R. Example: entry $10, SL $9, TP1 $11 (30% close), TP2 $12 (100% of remaining = 70%): reward = 0.30×$1 + 0.70×$2 = $1.70, risk = $1.00, R:R = 1.70. Higher is better. Required — must be computed and set for every signal.`,
    `tp1 and stopLoss are REQUIRED fields — set them to specific prices > 0 matching the trade direction (long: tp1 > entry > stopLoss; short: tp1 < entry < stopLoss). Never output 0 or omit them. A signal with tp1=0 or missing tp1 will be rejected by the hard gate and no trade will be placed.`,
    `tp1ClosePercent: percentage of position to close at TP1 (default 30 if omitted). tp2ClosePercent: percentage of remaining position to close at TP2 (default 100 if omitted, closes all remaining). Both are optional — omit to use defaults. Use tp2ClosePercent < 100 only when you want to trail a portion beyond TP2.`,
    `Rank exactly 5. Score reflects your own conviction (0-100). Set recommendation and conviction fields based on your judgment. Keep reasoning ≤ 100 chars and whyNow ≤ 120 chars per entry — output truncation loses all 5 signals.`,
    `Funding: |rate|<0.03% neutral; 0.03-0.07% directional signal; >0.07% crowded/squeeze risk. OI up+price up=bullish; OI down+price up=weak; OI up+price down=bearish; OI down+price down=weak.`,
    `Take profit placement: Primary method: identify nearest key resistance (long TP) or support (short TP) using 50-period high/low on 4h timeframe. Validation: TP distance must fall within the regime-calibrated band shown in the TP calibration line below — this overrides raw ATR multiples. ATR (1-3×) is a secondary sanity check only; do not override the regime band for ATR compliance. Secondary: Fibonacci 61.8% or 78.6% retracement as confirmation in trending markets. Final TP = structural level confirmed within regime band. TP2=2× TP1 distance. LONGS: SL<entry, TPs above. SHORTS: SL>entry, TPs below.
INITIAL SL (entry only — does NOT govern post-entry SL management): Place the SL at the price where this trade's thesis is invalidated. Determine that level yourself from the candle data across 15m / 1h / 4h — use whatever structural method best fits this setup (swing structure, Fibonacci, prior support/resistance, range boundary, etc.) and whichever timeframe fits: tighter for fast/breakout entries, wider for slower swings. 4h ATR is volatility context only, never the placement rule. Constraints: SL must sit just beyond a GENUINE structural level. Never place it at an arbitrary price chosen only to hit a target R:R — a stop inside candle noise gets wicked out. Blended R:R must be ≥ 1.1. If your invalidation level doesn't clear it, anchor to a genuinely tighter structural level on a faster timeframe only if a real one exists; if none does, return direction=neutral rather than forcing a wide stop. Record the level and basis in stopLossMethod (e.g. 'swing_1h', 'fib_0618', 'range_low'). This sets the INITIAL stop only — it does NOT alter TP1/TP2 bands or the post-entry SL ladder (breakeven, ratchets).
CRITICAL — do NOT tighten the SL into noise to pass the gate: The SL must sit beyond the GENUINE structural invalidation level — the actual swing low (longs) / swing high (shorts), placed clear of the recent wick/noise zone. If the genuine structural level gives blended R:R < 1.1, you have ONLY two valid choices: (1) Anchor to a genuinely tighter structural level on a faster timeframe IF a real one exists (a real swing, not a point inside the noise band). (2) If no genuine tighter structural level exists, return direction=neutral. You must NOT place the SL at an arbitrary price inside the noise/wick zone (e.g. just above the recent swing low) solely to make R:R clear 1.1. A stop inside the noise band will be wicked out without the thesis actually being invalidated. Placing the SL above the true swing low to pass the gate is an ERROR — return neutral instead. When you set the SL, identify the actual swing low/high you are placing beyond, and confirm the SL is on the far side of the recent wick zone, not inside it.`,
    `setupType=REJECTION|MOMENTUM|OVEREXTENDED|LIQUIDITY_SWEEP. setupQuality=HIGH|MEDIUM|LOW. timing=EARLY(fresh)|MIDDLE(1-2ATR)|LATE(3+ATR or RSI extreme) — skip LATE unless LIQUIDITY_SWEEP.`,
    `WHY NOW: name a specific edge — e.g. 'Funding +0.09% longs trapped at $96.5 rejection'. Generic → direction=neutral.`,
    `RS data: set relativeStrengthVsBtc. CONFLICTS: MAJOR_SKIP→direction=neutral. Sweep→sweepDetected=true+setupType=LIQUIDITY_SWEEP. Squeeze→squeezeDetected=true.`,
    `EXISTING POSITIONS: Do not suggest opening a position on any symbol that already has an open position (shown in "Bybit live positions" above). This applies regardless of direction — no adding a short on a symbol where a long is already open, and vice versa.`,
  ].join("\n");

  // Per-symbol regime section: shows each symbol's own 4h ADX/DI alongside BTC proxy.
  // When BTC is non-directional the cap column tells Claude which band governs each symbol.
  // Also appends computed 4h candle metrics (range/ATR, close position, volume ratio, run-up)
  // for the most extreme recent completed candle.  ⚠️BLOWOFF_SUSPECTED fires when all four
  // thresholds are met simultaneously — informational only, no suppression, no score change.
  const perSymbolRegimeSection = (() => {
    if (symRegimeMap.size === 0) return "";
    const lines = selectedSymbols.flatMap(sym => {
      const r  = symRegimeMap.get(sym);
      if (!r) return [];
      const bf = blowoffMap.get(sym);
      const bfStr = bf
        ? ` | 4h_spike: range=${bf.rangeAtr.toFixed(1)}×ATR close=${bf.closePos.toFixed(2)} vol=${bf.volRatio.toFixed(1)}×avg run20=${bf.run20 >= 0 ? "+" : ""}${bf.run20.toFixed(0)}%${bf.suspected ? " ⚠️BLOWOFF_SUSPECTED" : ""}`
        : "";
      return btcIsDirectional
        ? [`  ${sym}: ${r.regime} ADX=${r.adx.toFixed(0)} DI+=${r.diPlus.toFixed(0)} DI-=${r.diMinus.toFixed(0)}${bfStr}`]
        : [`  ${sym}: ${r.regime} ADX=${r.adx.toFixed(0)} DI+=${r.diPlus.toFixed(0)} DI-=${r.diMinus.toFixed(0)} → ${tpCapShort(r.regime)}${bfStr}`];
    });
    if (lines.length === 0) return "";
    return btcIsDirectional
      ? `Per-symbol 4h regimes (informational — BTC ${regime.regime} caps apply to all):\n${lines.join("\n")}`
      : `Per-symbol 4h regimes (BTC non-directional — each symbol uses own caps):\n${lines.join("\n")}`;
  })();

  // TP calibration line: single BTC-based line when BTC is directional;
  // defers to per-symbol caps above when BTC is non-directional.
  const tpCalibLine = btcIsDirectional
    ? `TP calibration (BTC ${regime.regime}): ${
        regime.regime === "STRONG_TREND" || regime.regime === "TRENDING_UP"
          ? "TP1 2–3% from entry, TP2 4–8% from entry. WARNING: 6–8% TP1 sits in the empirical dead zone — no STRONG_TREND long peaked between 3% and 8%. That setting misses the early partial and pushes TP2 to unreachable 16%+."
          : regime.regime === "TRENDING_DOWN"
          ? "LONGS ARE HARD-BLOCKED. Shorts only: TP1 2–3%, TP2 4–6%."
          : regime.regime === "CHOPPY"
          ? "TP1 max 1.5%, TP2 max 3.5% — CHOPPY; moves ~1–2% before reversal. TP1 at nearest structural level within cap. TP2 at 3.5% keeps R:R viable at realistic SLs; reversal protection from 0.8% early-breakeven trigger."
          : "TP1 within 1–3× ATR from structural level."
      }`
    : `TP calibration: BTC is ${regime.regime} (non-directional) — use each symbol's own caps from the per-symbol regime block above.`;

  // Dynamic per-scan context — regime metrics and risk sizing move to prompt so systemContext stays stable
  const prompt = [
    riskDirective,
    `Orders: LIMIT(GTC) mid-range at nearest S/R; MARKET(IOC) only on confirmed volume breakout. Max position: $${maxPosition.toFixed(0)}.`,
    ``,
    `Bybit live positions: ${bybitPosSummary}`,
    `Risk: ${profile?.riskTolerance ?? "high"}. Strategy: ${profile?.strategyType ?? "Momentum"}.`,
    `UTC: ${new Date().toISOString()}`,
    ``,
    `Market regime (BTC proxy): ${regime.regime}`,
    `ADX: ${regime.adx.toFixed(1)} | DI+: ${regime.diPlus.toFixed(1)} | DI-: ${regime.diMinus.toFixed(1)}`,
    `4h EMA20: $${regime.ema20_4h.toFixed(0)} | EMA50: $${regime.ema50_4h.toFixed(0)} | EMA200: $${regime.ema200_4h.toFixed(0)}`,
    `ATR: $${regime.atr.toFixed(0)} vs 30d avg: $${regime.atrAvg30d.toFixed(0)} (${regime.atr > 0 && regime.atrAvg30d > 0 ? (regime.atr / regime.atrAvg30d).toFixed(1) : "?"}×)`,
    `Regime note: ${regime.summary}`,
    perSymbolRegimeSection,
    tpCalibLine,
    ``,
    mtfLines.length      ? `Multi-timeframe data:\n${mtfLines.join("\n")}\n`                                          : "",
    candle1hLines.length   ? `1h OHLCV (last 50, oldest→newest):\n${candle1hLines.join("\n")}\n`                       : "",
    candle15mLines.length  ? `15m OHLCV (last 50, oldest→newest):\n${candle15mLines.join("\n")}\n`                     : "",
    volRatioLines.length   ? `Volume ratio vs 20-candle avg:\n${volRatioLines.join("\n")}\n`                           : "",
    fundingLines.length    ? `Funding rates & open interest:\n${fundingLines.join("\n")}\n`                             : "",
    orderbookLines.length  ? `Order book depth (top 50 bids/asks):\n${orderbookLines.join("\n")}\n`                     : "",
    fundingHistLines.length? `Funding rate history (24 periods, oldest→newest):\n${fundingHistLines.join("\n")}\n`      : "",
    liqLines.length        ? `Liquidation prices (@${leverage}x leverage, ~0.5% maint margin):\n${liqLines.join("\n")}\nSL must stay ≥2% above (longs) or ≤2% below (shorts) liquidation price.\n` : "",
    recentExitLines.length ? `Recent exits (last 24h — context for re-entry decisions):\n${recentExitLines.join("\n")}\n` : "",
    pendingLines.length    ? `Pending limit orders (unfilled — consider cancel/hold/skip):\n${pendingLines.join("\n")}\n` : "",
    rsContext ? `\n${rsContext}\n` : "",
    sweepContext   ? `\n${sweepContext}` : "",
    squeezeContext ? `\nSqueeze setups:\n${squeezeContext}` : "",
    `Market snapshot — top 10 selected (Symbol|Class|Price|7d%|30d%|RSI|Volume):`,
    tableRows.join("\n"),
    ``,
    tradeMemory ? `Trade memory (last reflections):\n${tradeMemory}` : "",
    perfSummary ? `\n${perfSummary}` : "",
    activeRules.length ? [
      `\n═══ ACTIVE TRADING RULES ═══`,
      `(Generated from trade reflections — SOFT rules: state which rule you override and why)`,
      ...activeRules.map(r => {
        const tot = r.winsFollowing + r.lossesFollowing;
        const wr  = tot > 0 ? `${Math.round(r.winsFollowing / tot * 100)}%` : "no data";
        return `Rule ${r.ruleNumber} [${r.confidence}]: ${r.ruleText}\n  Logic: ${r.causalLogic ?? "see evidence"} | Track record: ${r.winsFollowing}W/${r.lossesFollowing}L (${wr})`;
      }),
      `If overriding a rule, include "ruleOverridden": <number>, "overrideReason": "<specific reason>" in your response.`,
    ].join("\n") : "",
  ].filter(Boolean).join("\n");

  const res = await llm.json<{ opportunities: ScanOpportunity[]; scanTimestamp: string; summary: string }>({
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

  if (!res.parseSuccess) {
    console.error(`[scanner] Phase 2 FAILED — LLM output truncated or malformed (${res.text?.length ?? 0} chars). This is NOT a genuine no-signal scan.`);
    return { opportunities: [], scanFailed: true };
  }
  const opportunities = res.data.opportunities ?? [];
  // Override atr with each symbol's own 4h ATR computed from its klines.
  // Prevents Claude from copying the BTC regime ATR (prominently shown in the prompt) into alt trade records.
  // Also propagate blowoffSuspected and symRegime — pre-computed, not set by Claude.
  for (const opp of opportunities) {
    const symR = symRegimeMap.get(opp.symbol);
    if (symR && symR.atr > 0) opp.atr = symR.atr;
    if (symR) opp.symRegime = symR.regime;   // propagate per-symbol regime for rule selectivity
    const bf = blowoffMap.get(opp.symbol);
    if (bf?.suspected) opp.blowoffSuspected = true;
  }
  return { opportunities, scanFailed: false };
}

export async function runScan(): Promise<ScanResult> {
  return cache.get(CacheKey.marketScan(), TTL.MARKET_SCAN, async () => {
    // ── Phase 0: Regime + basic data ─────────────────────────────────────────
    const regime = await detectMarketRegime();

    const [watchlist, profile, bybitPositions, tradeMemory, perfSummary, activeRules, botState] = await Promise.all([
      getWatchlist(),
      db.select().from(profileTable).limit(1).then(r => r[0] ?? null),
      bybitGetPositions().catch(() => [] as BybitPosition[]),
      getRecentMemory(20).catch(() => ""),
      getPerformanceSummary().catch(() => ""),
      getActiveRules().catch(() => [] as Awaited<ReturnType<typeof getActiveRules>>),
      db.select({ portfolioLeverage: botStateTable.portfolioLeverage }).from(botStateTable).limit(1).then(r => r[0] ?? null),
    ]);
    const leverage = Math.min(botState?.portfolioLeverage ?? 10, 10);

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
      systemContext: 'You are helping select cryptocurrency trading opportunities, you are free to perform for both long and short positions. Review these symbols and select the top 10 most promising for detailed analysis. Goal: maximize trading returns. Respond ONLY with valid JSON: {"top10":["SYM1","SYM2",...10 items]}',
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

    const phase2 = await runPhase2(selectedSymbols, classMap, assetData, regime, bybitPosSummary, profile, tradeMemory, perfSummary, activeRules, leverage);

    const result: ScanResult = { opportunities: phase2.opportunities, regime, scanTimestamp: new Date().toISOString(), summary: "", scanFailed: phase2.scanFailed };
    return result;
  });
}

export async function runFocusedScan(symbols: string[]): Promise<ScanResult> {
  const regime = await detectMarketRegime();
  const [watchlist, profile, bybitPositions, tradeMemory, perfSummary, activeRules, botState] = await Promise.all([
    getWatchlist(),
    db.select().from(profileTable).limit(1).then(r => r[0] ?? null),
    bybitGetPositions().catch(() => [] as BybitPosition[]),
    getRecentMemory(20).catch(() => ""),
    getPerformanceSummary().catch(() => ""),
    getActiveRules().catch(() => [] as Awaited<ReturnType<typeof getActiveRules>>),
    db.select({ portfolioLeverage: botStateTable.portfolioLeverage }).from(botStateTable).limit(1).then(r => r[0] ?? null),
  ]);
  const leverage = Math.min(botState?.portfolioLeverage ?? 10, 10);

  const watchlistClassMap = Object.fromEntries(watchlist.map(e => [e.symbol, e.assetClass]));
  // Default to "Crypto" for watch coins not in the portfolio watchlist
  const classMap: Record<string, string> = {
    ...watchlistClassMap,
    ...Object.fromEntries(symbols.map(s => [s, watchlistClassMap[s] ?? "Crypto"])),
  };

  // Fetch asset data for just these symbols
  const focusedEntries = symbols.map(s => ({ symbol: s, assetClass: classMap[s] ?? "Crypto" }));
  const assetData = await fetchBatch(focusedEntries);

  const bybitPosSummary = bybitPositions.length
    ? bybitPositions.map(p => `${p.symbol} ${p.side} size=${p.size} pnl=${p.pnlPct.toFixed(1)}%`).join(", ")
    : "none";

  const phase2 = await runPhase2(symbols, classMap, assetData, regime, bybitPosSummary, profile, tradeMemory, perfSummary, activeRules, leverage);

  return { opportunities: phase2.opportunities, regime, scanTimestamp: new Date().toISOString(), summary: "", scanFailed: phase2.scanFailed };
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
