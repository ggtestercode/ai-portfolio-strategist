import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";

export const ruleOverridesTable = pgTable("rule_overrides", {
  id:               serial("id").primaryKey(),
  ruleId:           integer("rule_id").notNull(),
  symbol:           text("symbol").notNull(),
  direction:        text("direction"),
  overrideReason:   text("override_reason"),
  tradeResult:      text("trade_result").notNull().default("pending"), // win | loss | pending
  pnlPct:           numeric("pnl_pct", { precision: 8, scale: 4 }),
  confidenceBefore: text("confidence_before"),
  confidenceAfter:  text("confidence_after"),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RuleOverride       = typeof ruleOverridesTable.$inferSelect;
export type InsertRuleOverride = typeof ruleOverridesTable.$inferInsert;
