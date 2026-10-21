import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Replit reserves DATABASE_URL for its built-in Postgres, so the Supabase
// connection string lives under its own name.
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_DATABASE_URL?.trim());
}

let instance: { pool: pg.Pool; db: NodePgDatabase<typeof schema> } | undefined;

// Connects on first use so the API still starts (and non-database routes keep
// working) when SUPABASE_DATABASE_URL is missing.
function connect() {
  if (instance) return instance;
  const connectionString = process.env.SUPABASE_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      "SUPABASE_DATABASE_URL must be set to the Supabase session pooler connection string.",
    );
  }
  // Session-pooler slots are shared and limited; a few connections is plenty here.
  const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000 });
  instance = { pool, db: drizzle(pool, { schema }) };
  return instance;
}

export function getDb(): NodePgDatabase<typeof schema> {
  return connect().db;
}

export function getPool(): pg.Pool {
  return connect().pool;
}

export * from "./schema";
