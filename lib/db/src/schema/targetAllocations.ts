import { pgTable, text, real, serial } from "drizzle-orm/pg-core";

export const targetAllocationsTable = pgTable("target_allocations", {
  id: serial("id").primaryKey(),
  assetClass: text("asset_class").notNull().unique(),
  targetPct: real("target_pct").notNull(),
});

export type TargetAllocation = typeof targetAllocationsTable.$inferSelect;
