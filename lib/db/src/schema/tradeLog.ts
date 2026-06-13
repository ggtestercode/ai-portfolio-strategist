import { pgTable, uuid, text, numeric, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

export const tradeLogTable = pgTable("trade_log", {
  id:         uuid("id").primaryKey().defaultRandom(),
  symbol:     text("symbol").notNull(),
  broker:     text("broker").notNull().default("okx"),
  direction:  text("direction").notNull().default("long"), // "long" | "short"
  entryPrice: numeric("entry_price", { precision: 20, scale: 8 }),
  exitPrice:  numeric("exit_price",  { precision: 20, scale: 8 }),
  pnl:        numeric("pnl",         { precision: 12, scale: 4 }),
  pnlPct:     numeric("pnl_pct",     { precision: 8,  scale: 4 }),
  leverage:   integer("leverage").notNull().default(1),
  amountUsd:  numeric("amount_usd",  { precision: 12, scale: 2 }).notNull(),
  reasoning:  text("reasoning"),
  entryAt:    timestamp("entry_at",  { withTimezone: true }).notNull().defaultNow(),
  exitAt:     timestamp("exit_at",   { withTimezone: true }),
  reflection: text("reflection"),
  tp1:       numeric("tp1",       { precision: 20, scale: 8 }),
  tp2:       numeric("tp2",       { precision: 20, scale: 8 }),
  sl:         numeric("sl",          { precision: 20, scale: 8 }),
  effectiveSl: numeric("effective_sl", { precision: 20, scale: 8 }),
  atr:        numeric("atr",         { precision: 20, scale: 8 }),
  setupType: text("setup_type"),
  score:     numeric("score",     { precision: 8,  scale: 2 }),
  whyNow:         text("why_now"),
  appliedRuleIds: jsonb("applied_rule_ids").$type<number[]>(),
  blowoffSuspected: text("blowoff_suspected"),  // "1" when 4h blowoff pattern was present at entry; null otherwise
});

export type TradeLog       = typeof tradeLogTable.$inferSelect;
export type InsertTradeLog = typeof tradeLogTable.$inferInsert;
