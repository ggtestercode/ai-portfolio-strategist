import { db, watchlistTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface WatchlistEntry {
  symbol:    string;
  assetClass: string;
}

let _cache: WatchlistEntry[] | null = null;

export function invalidateWatchlistCache(): void {
  _cache = null;
}

export async function getWatchlist(): Promise<WatchlistEntry[]> {
  if (_cache) return _cache;
  const rows = await db.select().from(watchlistTable).orderBy(watchlistTable.symbol);
  _cache = rows.map(r => ({ symbol: r.symbol, assetClass: r.assetClass }));
  return _cache;
}

export async function addToWatchlist(symbol: string, assetClass: string): Promise<void> {
  const sym = symbol.toUpperCase();
  await db.insert(watchlistTable).values({ symbol: sym, assetClass }).onConflictDoNothing();
  invalidateWatchlistCache();
}

export async function removeFromWatchlist(symbol: string): Promise<boolean> {
  const result = await db.delete(watchlistTable)
    .where(eq(watchlistTable.symbol, symbol.toUpperCase()))
    .returning();
  if (result.length > 0) invalidateWatchlistCache();
  return result.length > 0;
}
