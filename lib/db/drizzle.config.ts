import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// drizzle-kit uses the standard 'pg' driver (TCP/SSL) for schema push.
// The runtime app uses @neondatabase/serverless (WebSocket) — same DB, different transport.
export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  driver: "pg",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
