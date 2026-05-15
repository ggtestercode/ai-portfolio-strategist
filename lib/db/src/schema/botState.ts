import { pgTable, integer, real, boolean, timestamp, text, jsonb } from "drizzle-orm/pg-core";

export interface CoinPenalty {
  penalty:         number;
  consecutiveHits: number;
  suspended:       boolean;
}

export interface PositionMeta {
  originalQty:      number;
  entryPrice:       number;
  sl:               number;
  atr:              number;
  tp1:              number;
  tp2:              number;
  openedAt:         number; // epoch ms
  entrySource?:     "manual_nl" | "auto_scan";
  trailingActive?:  boolean; // trailing SL has been activated
  lastTrailPrice?:  number;  // price at which trail was last updated
}

export interface PositionMonitorState {
  lastReviewAt:    number;  // epoch ms
  lastFundingRate: number;
  lastOI:          number;
  lastRSI1h:       number;
}

export const botStateTable = pgTable("bot_state", {
  id:                   integer("id").primaryKey().default(1),
  portfolioLeverage:    integer("portfolio_leverage").notNull().default(10),
  coinPenalties:        jsonb("coin_penalties").$type<Record<string, CoinPenalty>>().notNull().default({}),
  dailyPnl:             real("daily_pnl").notNull().default(0),
  tradingPaused:        boolean("trading_paused").notNull().default(false),
  pausedReason:         text("paused_reason"),
  lastUpdated:          timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
  // 5-layer architecture additions
  peakEquity:           real("peak_equity"),
  currentRegime:        text("current_regime"),
  regimeChangedAt:      timestamp("regime_changed_at", { withTimezone: true }),
  dailyLossStartEquity: real("daily_loss_start_equity"),
  positionMetadata:     jsonb("position_metadata").$type<Record<string, PositionMeta>>().notNull().default({}),
  positionMonitorState: jsonb("position_monitor_state").$type<Record<string, PositionMonitorState>>().notNull().default({}),
});

export type BotState       = typeof botStateTable.$inferSelect;
export type InsertBotState = typeof botStateTable.$inferInsert;
