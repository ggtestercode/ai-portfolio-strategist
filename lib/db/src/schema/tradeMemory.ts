import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const tradeMemoryTable = pgTable("trade_memory", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  symbol:               text("symbol").notNull(),
  reflection:           text("reflection").notNull(),
  whatWorked:           text("what_worked"),
  whatDidnt:            text("what_didnt"),
  createdAt:            timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Structured reflection fields — batch 1 (deployed prev session)
  lessonsLearned:       text("lessons_learned"),
  nextTimeWouldDo:      text("next_time_would_do"),
  entryQuality:         text("entry_quality"),     // good | ok | poor
  directionCorrect:     text("direction_correct"), // true | false
  slPlacement:          text("sl_placement"),      // good | too_tight | too_wide
  tpRealism:            text("tp_realism"),        // good | too_tight | too_ambitious
  partialsCorrect:      text("partials_correct"),  // good | too_early | too_late | na
  // Partial close tracking — batch 1
  action:               text("action"),            // TRADE_CLOSE | PARTIAL
  partialType:          text("partial_type"),      // tp1 | tp2 | large_profit | review
  closePct:             text("close_pct"),
  priceAtClose:         text("price_at_close"),
  remainingPct:         text("remaining_pct"),
  // Extended reflection fields — batch 2 (this session)
  entryTiming:          text("entry_timing"),          // early | middle | late
  sizingCorrect:        text("sizing_correct"),        // true | false
  marketContextCorrect: text("market_context_correct"),// true | false
  mistakeType:          text("mistake_type"),          // wrong_direction | late_entry | ...
  signalsThatWorked:    text("signals_that_worked"),   // JSON array string
  signalsThatFailed:    text("signals_that_failed"),   // JSON array string
  versionBLesson:       text("version_b_lesson"),
  pnlPct:               text("pnl_pct"),               // stored for display without joining trade_log
});

export type TradeMemory       = typeof tradeMemoryTable.$inferSelect;
export type InsertTradeMemory = typeof tradeMemoryTable.$inferInsert;
