import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const tradeMemoryTable = pgTable("trade_memory", {
  id:               uuid("id").primaryKey().defaultRandom(),
  symbol:           text("symbol").notNull(),
  reflection:       text("reflection").notNull(),
  whatWorked:       text("what_worked"),
  whatDidnt:        text("what_didnt"),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Structured reflection fields (FIX 3)
  lessonsLearned:   text("lessons_learned"),
  nextTimeWouldDo:  text("next_time_would_do"),
  entryQuality:     text("entry_quality"),     // good | ok | poor
  directionCorrect: text("direction_correct"), // true | false
  slPlacement:      text("sl_placement"),      // good | too_tight | too_wide
  tpRealism:        text("tp_realism"),        // good | too_tight | too_ambitious
  partialsCorrect:  text("partials_correct"),  // good | too_early | too_late | na
  // Partial close tracking (FIX 5)
  action:           text("action"),            // TRADE_CLOSE | PARTIAL
  partialType:      text("partial_type"),      // tp1 | tp2 | large_profit | review
  closePct:         text("close_pct"),
  priceAtClose:     text("price_at_close"),
  remainingPct:     text("remaining_pct"),
});

export type TradeMemory       = typeof tradeMemoryTable.$inferSelect;
export type InsertTradeMemory = typeof tradeMemoryTable.$inferInsert;
