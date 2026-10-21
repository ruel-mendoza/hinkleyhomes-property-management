import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Replit reserves DATABASE_URL for its built-in Postgres, so the Supabase
// connection string lives under its own name.
const connectionString = process.env.SUPABASE_DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "SUPABASE_DATABASE_URL must be set to the Supabase session pooler connection string.",
  );
}

export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });

export * from "./schema";
