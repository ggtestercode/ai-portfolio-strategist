import { drizzle }  from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

// Use WebSocket transport (port 443) — avoids ISP/firewall blocks on port 5432
neonConfig.webSocketConstructor = ws;

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db   = drizzle(pool, { schema });

// Warm up + keep alive: re-ping every 4 min so Neon doesn't auto-suspend
pool.query("SELECT 1").catch(() => {});
setInterval(() => { pool.query("SELECT 1").catch(() => {}); }, 4 * 60 * 1000);

export * from "./schema";
export * from "./schema/operation";
// holdingsTable already in schema exports
