import {
  pgTable,
  text,
  serial,
  timestamp,
} from "drizzle-orm/pg-core";

export const assistantMessagesTable = pgTable("assistant_messages", {
  id: serial("id").primaryKey(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AssistantMessage = typeof assistantMessagesTable.$inferSelect;
