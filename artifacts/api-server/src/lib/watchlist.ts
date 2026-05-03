import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { getTopCryptoByMarketCap, getSP500Symbols } from "../data/marketData";

export interface WatchlistEntry {
  symbol:    string;
  assetClass: string;
}

const WATCHLIST_PATH = path.resolve(process.cwd(), "watchlist.json");

let _cache: WatchlistEntry[] | null = null;

function persist(list: WatchlistEntry[]): void {
  try { writeFileSync(WATCHLIST_PATH, JSON.stringify(list, null, 2)); }
  catch (e) { console.error("[watchlist] save failed:", e); }
}

export async function getWatchlist(): Promise<WatchlistEntry[]> {
  if (_cache) return _cache;

  if (existsSync(WATCHLIST_PATH)) {
    try {
      _cache = JSON.parse(readFileSync(WATCHLIST_PATH, "utf-8")) as WatchlistEntry[];
      if (_cache.length) return _cache;
    } catch { /* fall through */ }
  }

  // Build default: OKX perpetuals + top-20 crypto + top-50 S&P 500
  const okxDerivatives: WatchlistEntry[] = [
    { symbol: "BTC-USDT-SWAP", assetClass: "Derivative" },
    { symbol: "ETH-USDT-SWAP", assetClass: "Derivative" },
    { symbol: "SOL-USDT-SWAP", assetClass: "Derivative" },
    { symbol: "BNB-USDT-SWAP", assetClass: "Derivative" },
  ];

  const crypto: WatchlistEntry[] = [];
  try {
    const top = await getTopCryptoByMarketCap(20);
    for (const c of top) crypto.push({ symbol: c.symbol, assetClass: "Crypto" });
  } catch {
    for (const s of ["BTC","ETH","SOL","BNB","XRP","ADA","AVAX","DOT","MATIC","LINK"])
      crypto.push({ symbol: s, assetClass: "Crypto" });
  }

  const stocks: WatchlistEntry[] = getSP500Symbols()
    .slice(0, 50)
    .map(s => ({ symbol: s, assetClass: "Equity" }));

  _cache = [...okxDerivatives, ...crypto, ...stocks];
  persist(_cache);
  return _cache;
}

export async function addToWatchlist(symbol: string, assetClass: string): Promise<void> {
  const list = await getWatchlist();
  const sym  = symbol.toUpperCase();
  if (!list.find(e => e.symbol === sym)) {
    list.push({ symbol: sym, assetClass });
    persist(list);
  }
}

export async function removeFromWatchlist(symbol: string): Promise<boolean> {
  const list = await getWatchlist();
  const idx  = list.findIndex(e => e.symbol === symbol.toUpperCase());
  if (idx === -1) return false;
  list.splice(idx, 1);
  persist(list);
  return true;
}
