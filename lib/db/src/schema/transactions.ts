import {
  pgTable,
  text,
  real,
  serial,
  timestamp,
} from "drizzle-orm/pg-core";

export const transactionsTable = pgTable("transactions", {
  id: serial("id").primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  type: text("type").notNull(),
  asset: text("asset").notNull(),
  amount: real("amount").notNull(),
  value: real("value").notNull(),
  status: text("status").notNull().default("Completed"),
  note: text("note"),
});

export type Transaction = typeof transactionsTable.$inferSelect;
