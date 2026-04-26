import {
  pgTable,
  text,
  real,
  serial,
  timestamp,
} from "drizzle-orm/pg-core";

export const tradeSuggestionsTable = pgTable("trade_suggestions", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  pair: text("pair").notNull(),
  side: text("side").notNull(),
  status: text("status").notNull().default("Open"),
  entryRangeLow: real("entry_range_low").notNull(),
  entryRangeHigh: real("entry_range_high").notNull(),
  target: real("target").notNull(),
  stopLoss: real("stop_loss").notNull(),
  positionSize: text("position_size"),
  suggestedAction: text("suggested_action"),
  reasoning: text("reasoning"),
  riskWarning: text("risk_warning").notNull(),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TradeSuggestion = typeof tradeSuggestionsTable.$inferSelect;
