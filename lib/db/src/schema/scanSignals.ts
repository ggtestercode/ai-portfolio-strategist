import { pgTable, uuid, text, numeric, timestamp } from "drizzle-orm/pg-core";

export const scanSignalsTable = pgTable("scan_signals", {
  id:             uuid("id").primaryKey().defaultRandom(),
  scannedAt:      timestamp("scanned_at").notNull().defaultNow(),
  symbol:         text("symbol").notNull(),
  assetClass:     text("asset_class").notNull(),
  recommendation: text("recommendation").notNull(),
  score:          numeric("score", { precision: 5, scale: 2 }).notNull(),
  reasoning:      text("reasoning").notNull(),
  price:          numeric("price", { precision: 20, scale: 8 }).notNull(),
  dataTimestamp:  text("data_timestamp").notNull(),
});

export type ScanSignal       = typeof scanSignalsTable.$inferSelect;
export type InsertScanSignal = typeof scanSignalsTable.$inferInsert;
