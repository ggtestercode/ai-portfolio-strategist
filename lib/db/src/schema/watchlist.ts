import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const watchlistTable = pgTable("watchlist", {
  id:         serial("id").primaryKey(),
  symbol:     text("symbol").notNull().unique(),
  assetClass: text("asset_class").notNull(),
  addedAt:    timestamp("added_at").notNull().defaultNow(),
});

export type WatchlistRow       = typeof watchlistTable.$inferSelect;
export type InsertWatchlistRow = typeof watchlistTable.$inferInsert;
