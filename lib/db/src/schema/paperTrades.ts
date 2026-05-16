import { pgTable, serial, real, text, timestamp } from "drizzle-orm/pg-core";

export const paperTradesTable = pgTable("paper_trades", {
  id:              serial("id").primaryKey(),
  symbol:          text("symbol").notNull(),
  direction:       text("direction").notNull(),
  entryPrice:      real("entry_price").notNull(),
  stopLoss:        real("stop_loss"),
  tp1:             real("tp1"),
  tp2:             real("tp2"),
  rr:              real("rr"),
  regime:          text("regime"),
  score:           real("score"),
  whyNow:          text("why_now"),
  setupType:       text("setup_type"),
  signalTime:      timestamp("signal_time").notNull().defaultNow(),
  exitPrice:       real("exit_price"),
  exitTime:        timestamp("exit_time"),
  wouldHavePnl:    real("would_have_pnl"),
  wouldHavePnlPct: real("would_have_pnl_pct"),
  status:          text("status").notNull().default("open"),
  version:         text("version").notNull().default("B"),
});

export type PaperTrade       = typeof paperTradesTable.$inferSelect;
export type InsertPaperTrade = typeof paperTradesTable.$inferInsert;
