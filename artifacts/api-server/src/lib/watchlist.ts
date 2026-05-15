import { db, watchlistTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface WatchlistEntry {
  symbol:    string;
  assetClass: string;
}

export async function getWatchlist(): Promise<WatchlistEntry[]> {
  const rows = await db.select().from(watchlistTable).orderBy(watchlistTable.symbol);
  return rows.map(r => ({ symbol: r.symbol, assetClass: r.assetClass }));
}

export async function addToWatchlist(symbol: string, assetClass: string): Promise<void> {
  const sym = symbol.toUpperCase();
  await db.insert(watchlistTable).values({ symbol: sym, assetClass }).onConflictDoNothing();
}

export async function removeFromWatchlist(symbol: string): Promise<boolean> {
  const result = await db.delete(watchlistTable)
    .where(eq(watchlistTable.symbol, symbol.toUpperCase()))
    .returning();
  return result.length > 0;
}
