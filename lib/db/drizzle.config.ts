import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// drizzle-kit uses pg (TCP/SSL) implicitly for postgresql dialect.
// The runtime app uses @neondatabase/serverless (WebSocket) — same DB, different transport.
export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // Exclude ad-hoc backup tables so drizzle-kit push runs non-interactively.
  // Tables matching these patterns are left untouched — drizzle never sees them.
  tablesFilter: ["!trade_memory_backup*", "!trading_rules_backup*"],
});
