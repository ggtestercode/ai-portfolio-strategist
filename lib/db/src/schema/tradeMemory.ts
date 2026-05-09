import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const tradeMemoryTable = pgTable("trade_memory", {
  id:         uuid("id").primaryKey().defaultRandom(),
  symbol:     text("symbol").notNull(),
  reflection: text("reflection").notNull(),
  whatWorked: text("what_worked"),
  whatDidnt:  text("what_didnt"),
  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TradeMemory       = typeof tradeMemoryTable.$inferSelect;
export type InsertTradeMemory = typeof tradeMemoryTable.$inferInsert;
