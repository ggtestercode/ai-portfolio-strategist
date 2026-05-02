import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const approvalsTable = pgTable("approvals", {
  id:          uuid("id").primaryKey().defaultRandom(),
  proposalId:  text("proposal_id").notNull(),
  action:      text("action", { enum: ["approve", "reject"] }).notNull(),
  resolvedBy:  text("resolved_by").notNull().default("web"),
  resolvedAt:  timestamp("resolved_at").notNull().defaultNow(),
  note:        text("note"),
});

export type Approval       = typeof approvalsTable.$inferSelect;
export type InsertApproval = typeof approvalsTable.$inferInsert;
