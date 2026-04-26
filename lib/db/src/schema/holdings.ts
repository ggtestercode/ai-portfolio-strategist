import { pgTable, text, real, serial } from "drizzle-orm/pg-core";

export const holdingsTable = pgTable("holdings", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  assetClass: text("asset_class").notNull(),
  quantity: real("quantity").notNull(),
  price: real("price").notNull(),
  change24hPct: real("change_24h_pct").notNull(),
});

export type Holding = typeof holdingsTable.$inferSelect;
