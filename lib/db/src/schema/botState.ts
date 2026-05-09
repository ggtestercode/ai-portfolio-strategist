import { pgTable, integer, real, boolean, timestamp, text, jsonb } from "drizzle-orm/pg-core";

export interface CoinPenalty {
  penalty:         number;
  consecutiveHits: number;
  suspended:       boolean;
}

export const botStateTable = pgTable("bot_state", {
  id:                integer("id").primaryKey().default(1),
  portfolioLeverage: integer("portfolio_leverage").notNull().default(10),
  coinPenalties:     jsonb("coin_penalties").$type<Record<string, CoinPenalty>>().notNull().default({}),
  dailyPnl:          real("daily_pnl").notNull().default(0),
  tradingPaused:     boolean("trading_paused").notNull().default(false),
  pausedReason:      text("paused_reason"),
  lastUpdated:       timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
});

export type BotState       = typeof botStateTable.$inferSelect;
export type InsertBotState = typeof botStateTable.$inferInsert;
