import { pgTable, uuid, text, timestamp, jsonb, boolean, decimal } from "drizzle-orm/pg-core";

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
  sourceTradeId:        text("source_trade_id"),        // trade_log.id for exact deduplication
  // Execution quality tracking — batch 3
  failureType:          text("failure_type"),           // 'strategy' | 'execution' | 'mixed' | 'success'
  executionIssues:      jsonb("execution_issues"),      // string[]
  tp1Reached:           boolean("tp1_reached"),
  tp2Reached:           boolean("tp2_reached"),
  maxProfitPct:         decimal("max_profit_pct", { precision: 10, scale: 4 }),
  profitProtectionMissed: boolean("profit_protection_missed"),
  slippagePct:          decimal("slippage_pct", { precision: 10, scale: 4 }),
  excessivePartials:    boolean("excessive_partials"),
  exitMethod:           text("exit_method"),            // 'review' | 'sl_hit' | 'tp_hit' | '48h_timer' | 'profit_protection' | 'unknown'
  metadataWasStale:     boolean("metadata_was_stale"),
  // Candle & signal analysis fields — batch 4
  entryCandleQuality:     text("entry_candle_quality"),             // strong | neutral | weak
  entryVolumeConfirmed:   boolean("entry_volume_confirmed"),
  preTradeWarningsMissed: jsonb("pre_trade_warnings_missed").$type<string[]>(),
  preTradeConfirmations:  jsonb("pre_trade_confirmations").$type<string[]>(),
  slWasCorrect:           boolean("sl_was_correct"),
  tpWasConservative:      boolean("tp_was_conservative"),
  missedGainPct:          decimal("missed_gain_pct",    { precision: 10, scale: 4 }),
  continuedLossPct:       decimal("continued_loss_pct", { precision: 10, scale: 4 }),
  candlePatternLesson:    text("candle_pattern_lesson"),
  signalAccuracyInsight:  text("signal_accuracy_insight"),
  btcContextPre:          text("btc_context_pre"),
  btcContextPost:         text("btc_context_post"),
  price1hAfter:           decimal("price_1h_after",  { precision: 20, scale: 8 }),
  price4hAfter:           decimal("price_4h_after",  { precision: 20, scale: 8 }),
  price24hAfter:          decimal("price_24h_after", { precision: 20, scale: 8 }),
  // Structured verdict fields — batch 5
  entryTimingVerdict:     text("entry_timing_verdict"),   // 'early'|'good'|'late'|'wrong'
  slTooTight:             boolean("sl_too_tight"),
  slTooWide:              boolean("sl_too_wide"),
  tp1Verdict:             text("tp1_verdict"),             // 'too_tight'|'good'|'too_ambitious'
  tp2Verdict:             text("tp2_verdict"),
  partialTiming:          text("partial_timing"),          // 'correct'|'too_early'|'too_late'|'na'
  manualCloseVerdict:     text("manual_close_verdict"),    // 'correct'|'wrong'|'neutral'|'na'
  profitMissedPct:        decimal("profit_missed_pct",    { precision: 10, scale: 4 }),
  optimalEntryPrice:      decimal("optimal_entry_price",  { precision: 20, scale: 8 }),
  optimalSlPrice:         decimal("optimal_sl_price",     { precision: 20, scale: 8 }),
  optimalTp1Price:        decimal("optimal_tp1_price",    { precision: 20, scale: 8 }),
  optimalPnlPct:          decimal("optimal_pnl_pct",      { precision: 10, scale: 4 }),
  opportunityCostPct:     decimal("opportunity_cost_pct", { precision: 10, scale: 4 }),
  // Source tracking — batch 6
  source:                 text("source"),  // 'mode_3' | 'version_b'
  // Phase 3 reconstruction — batch 7
  pnlSource:              text("pnl_source"),            // 'actual' | 'reconstructed' | 'ambiguous_excluded'
  reconstructedOutcome:   text("reconstructed_outcome"), // 'tp2_hit' | 'sl_hit' | 'inconclusive_review'
});

export type TradeMemory       = typeof tradeMemoryTable.$inferSelect;
export type InsertTradeMemory = typeof tradeMemoryTable.$inferInsert;
