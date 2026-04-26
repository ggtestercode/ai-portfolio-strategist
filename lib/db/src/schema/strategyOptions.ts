import {
  pgTable,
  text,
  serial,
  integer,
  real,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export type StrategyPick = {
  symbol: string;
  name: string;
  assetClass: string;
  weightPct: number;
  rationale: string;
};

export const strategyOptionsTable = pgTable("strategy_options", {
  id: serial("id").primaryKey(),
  optionIndex: integer("option_index").notNull(),
  name: text("name").notNull(),
  summary: text("summary").notNull(),
  riskLevel: text("risk_level").notNull(),
  expectedReturnPct: real("expected_return_pct").notNull(),
  picks: jsonb("picks").$type<StrategyPick[]>().notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type StrategyOption = typeof strategyOptionsTable.$inferSelect;
