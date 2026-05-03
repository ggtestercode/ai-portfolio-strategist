import {
  pgTable, text, numeric, boolean,
  timestamp, integer, uuid
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ── Operation config — single row stores mode + thresholds ───────────────────
export const operationConfig = pgTable("operation_config", {
  id:                   text("id").primaryKey().default("singleton"),
  mode:                 text("mode", { enum: ["autonomous", "approval"] })
                          .notNull().default("approval"),
  approvalThresholdUsd: numeric("approval_threshold_usd", { precision: 10, scale: 2 })
                          .notNull().default("500"),
  dailyLlmBudgetUsd:    numeric("daily_llm_budget_usd", { precision: 10, scale: 4 })
                          .notNull().default("2.0000"),
  updatedAt:            timestamp("updated_at").notNull().defaultNow(),
});

export const insertOperationConfigSchema = createInsertSchema(operationConfig);
export const selectOperationConfigSchema = createSelectSchema(operationConfig);
export type OperationConfig       = typeof operationConfig.$inferSelect;
export type InsertOperationConfig = typeof operationConfig.$inferInsert;

// ── Trade proposals — every proposed trade regardless of outcome ──────────────
export const tradeProposals = pgTable("trade_proposals", {
  id:              uuid("id").primaryKey().defaultRandom(),
  symbol:          text("symbol").notNull(),
  side:            text("side", { enum: ["buy", "sell"] }).notNull(),
  amountUsd:       numeric("amount_usd", { precision: 12, scale: 2 }).notNull(),
  assetClass:      text("asset_class").notNull(),
  broker:          text("broker", { enum: ["etoro", "bybit", "okx", "mock"] })
                     .notNull().default("mock"),
  rationale:       text("rationale").notNull(),
  score:           numeric("score", { precision: 5, scale: 2 }),
  currentPrice:    numeric("current_price", { precision: 20, scale: 8 }),
  dataTimestamp:   text("data_timestamp"),
  status:          text("status", {
                     enum: ["pending","approved","rejected","executed","expired","failed"]
                   }).notNull().default("pending"),
  proposedAt:      timestamp("proposed_at").notNull().defaultNow(),
  resolvedAt:      timestamp("resolved_at"),
  expiresAt:       timestamp("expires_at"),
  orderId:         text("order_id"),
  executionError:  text("execution_error"),
  approvalSummary: text("approval_summary"),
});

export const insertTradeProposalSchema = createInsertSchema(tradeProposals);
export const selectTradeProposalSchema = createSelectSchema(tradeProposals);
export type TradeProposal       = typeof tradeProposals.$inferSelect;
export type InsertTradeProposal = typeof tradeProposals.$inferInsert;

// ── LLM usage logs — every API call logged for cost monitoring ────────────────
export const llmUsageLogs = pgTable("llm_usage_logs", {
  id:               uuid("id").primaryKey().defaultRandom(),
  calledAt:         timestamp("called_at").notNull().defaultNow(),
  taskType:         text("task_type").notNull(),
  model:            text("model").notNull(),
  inputTokens:      integer("input_tokens").notNull().default(0),
  outputTokens:     integer("output_tokens").notNull().default(0),
  cachedTokens:     integer("cached_tokens").notNull().default(0),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 10, scale: 6 })
                      .notNull().default("0"),
  latencyMs:        integer("latency_ms").notNull().default(0),
  success:          boolean("success").notNull().default(true),
  errorMessage:     text("error_message"),
});

export const insertLlmUsageLogSchema = createInsertSchema(llmUsageLogs);
export const selectLlmUsageLogSchema = createSelectSchema(llmUsageLogs);
export type LlmUsageLog       = typeof llmUsageLogs.$inferSelect;
export type InsertLlmUsageLog = typeof llmUsageLogs.$inferInsert;
