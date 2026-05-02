import { cache, TTL, CacheKey } from "../lib/contextCache";

export interface AssetData {
  symbol:        string;
  price:         number;
  change7d:      number;  // pct
  change30d:     number;  // pct
  volume:        number;
  rsi:           number;
  dataTimestamp: string;  // UTC ISO
}

// Mutable at runtime — getTopCryptoByMarketCap adds entries dynamically
const COINGECKO_IDS: Record<string, string> = {
  BTC:   "bitcoin",      ETH:   "ethereum",      SOL:   "solana",
  BNB:   "binancecoin",  XRP:   "ripple",         ADA:   "cardano",
  AVAX:  "avalanche-2",  DOT:   "polkadot",       MATIC: "matic-network",
  LINK:  "chainlink",    ATOM:  "cosmos",          INJ:   "injective-protocol",
  TIA:   "celestia",     SUI:   "sui",             SEI:   "sei-network",
  ARB:   "arbitrum",     OP:    "optimism",        DOGE:  "dogecoin",
  LTC:   "litecoin",     UNI:   "uniswap",         PEPE:  "pepe",
  TON:   "the-open-network", SHIB: "shiba-inu",   APT:   "aptos",
  WIF:   "dogwifcoin",   BONK:  "bonk",            FET:   "fetch-ai",
};

function computeRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(1).map((c, i) => c - closes[i]!);
  const recentChanges = changes.slice(-period);
  const avgGain = recentChanges.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  const avgLoss = recentChanges.filter(c => c < 0).reduce((a, b) => a + Math.abs(b), 0) / period;
  if (avgLoss === 0) return 100;
  return Math.round(100 - (100 / (1 + avgGain / avgLoss)));
}

export async function fetchYahooData(symbol: string): Promise<AssetData> {
  return cache.get(CacheKey.marketPrice(symbol), TTL.MARKET_PRICES, async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=30d`;
    const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json  = await res.json() as any;
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(`Yahoo ${symbol}: no chart result`);

    const meta    = result.meta as Record<string, unknown>;
    const rawClose: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
    const rawVol:   (number | null)[] = result.indicators?.quote?.[0]?.volume ?? [];
    const closes  = rawClose.filter((c): c is number => c != null);
    const volumes = rawVol.filter((v): v is number => v != null);

    const price      = (meta.regularMarketPrice as number) ?? closes.at(-1) ?? 0;
    const p7         = closes.at(-8) ?? closes[0] ?? price;
    const p30        = closes[0] ?? price;
    const change7d   = p7  ? ((price - p7)  / p7)  * 100 : 0;
    const change30d  = p30 ? ((price - p30) / p30) * 100 : 0;

    return {
      symbol,
      price,
      change7d:  +change7d.toFixed(2),
      change30d: +change30d.toFixed(2),
      volume:    volumes.at(-1) ?? 0,
      rsi:       computeRsi(closes),
      dataTimestamp: new Date().toISOString(),
    };
  });
}

export async function fetchCoinGeckoData(symbol: string): Promise<AssetData> {
  return cache.get(CacheKey.marketPrice(symbol), TTL.MARKET_PRICES, async () => {
    const id = COINGECKO_IDS[symbol.toUpperCase()] ?? symbol.toLowerCase();
    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=30&interval=daily`;
    const res  = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`CoinGecko ${symbol}: HTTP ${res.status}`);

    const json = await res.json() as { prices: [number, number][]; total_volumes: [number, number][] };
    const prices  = json.prices ?? [];
    const volumes = json.total_volumes ?? [];
    if (!prices.length) throw new Error(`CoinGecko ${symbol}: empty prices`);

    const closes  = prices.map(([, p]) => p);
    const price   = closes.at(-1) ?? 0;
    const p7      = closes.at(-8) ?? closes[0] ?? price;
    const p30     = closes[0] ?? price;
    const change7d  = p7  ? ((price - p7)  / p7)  * 100 : 0;
    const change30d = p30 ? ((price - p30) / p30) * 100 : 0;

    return {
      symbol,
      price,
      change7d:  +change7d.toFixed(2),
      change30d: +change30d.toFixed(2),
      volume:    volumes.at(-1)?.[1] ?? 0,
      rsi:       computeRsi(closes),
      dataTimestamp: new Date().toISOString(),
    };
  });
}

const CRYPTO_CLASSES = new Set(["Crypto", "crypto", "cryptocurrency", "Cryptocurrency"]);

export async function fetchAssetData(symbol: string, assetClass: string): Promise<AssetData> {
  return CRYPTO_CLASSES.has(assetClass)
    ? fetchCoinGeckoData(symbol)
    : fetchYahooData(symbol);
}

export async function getTopCryptoByMarketCap(limit = 20): Promise<Array<{ symbol: string; name: string }>> {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`;
  const res  = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`CoinGecko markets: HTTP ${res.status}`);
  const coins = await res.json() as Array<{ symbol: string; name: string; id: string }>;
  for (const c of coins) COINGECKO_IDS[c.symbol.toUpperCase()] = c.id;
  return coins.map(c => ({ symbol: c.symbol.toUpperCase(), name: c.name }));
}

// S&P 500 top ~100 by market cap (April 2025)
export function getSP500Symbols(): string[] {
  return [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","BRK-B","LLY","AVGO",
    "TSLA","WMT","JPM","V","UNH","XOM","ORCL","MA","COST","HD",
    "PG","JNJ","ABBV","BAC","NFLX","CRM","MRK","CVX","AMD","PEP",
    "TMO","KO","ACN","LIN","ADBE","CSCO","QCOM","TXN","WFC","MS",
    "PM","AMGN","AXP","DIS","BX","ABT","INTU","ISRG","MCD","RTX",
    "GE","GS","T","VZ","SPGI","PFE","NEE","CAT","BLK","SYK",
    "HON","ETN","BKNG","PGR","UBER","LOW","TJX","AMAT","DE","SCHW",
    "CB","COP","MDT","BMY","ADI","VRTX","LMT","C","BSX","UNP",
    "PANW","REGN","MU","CI","SO","SBUX","KLAC","GD","ICE","MMC",
    "CME","LRCX","PLD","NOC","APH","AON","ITW","ADP","MDLZ","TGT",
  ];
}
