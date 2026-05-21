import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const tradingRulesTable = pgTable("trading_rules", {
  id:              serial("id").primaryKey(),
  ruleNumber:      integer("rule_number").notNull().unique(),
  ruleText:        text("rule_text").notNull(),
  evidence:        text("evidence"),
  causalLogic:     text("causal_logic"),
  confidence:      text("confidence").notNull().default("LOW"), // HIGH | MEDIUM | LOW
  occurrences:     integer("occurrences").notNull().default(0),
  winsFollowing:   integer("wins_following").notNull().default(0),
  lossesFollowing: integer("losses_following").notNull().default(0),
  active:          boolean("active").notNull().default(true),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TradingRule       = typeof tradingRulesTable.$inferSelect;
export type InsertTradingRule = typeof tradingRulesTable.$inferInsert;
