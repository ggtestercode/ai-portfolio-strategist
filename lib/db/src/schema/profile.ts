import {
  pgTable,
  text,
  serial,
  integer,
  real,
  timestamp,
} from "drizzle-orm/pg-core";

export const profileTable = pgTable("profile", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  avatarUrl: text("avatar_url"),
  totalCapital: real("total_capital").notNull(),
  targetReturnPct: real("target_return_pct").notNull(),
  timeHorizonMonths: integer("time_horizon_months").notNull(),
  riskTolerance: text("risk_tolerance").notNull(),
  strategyType: text("strategy_type").notNull(),
  strategyRiskLevel: text("strategy_risk_level").notNull(),
  strategyKeyRules: text("strategy_key_rules").array().notNull(),
  strategyLastGenerated: timestamp("strategy_last_generated", {
    withTimezone: true,
  })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Profile = typeof profileTable.$inferSelect;
