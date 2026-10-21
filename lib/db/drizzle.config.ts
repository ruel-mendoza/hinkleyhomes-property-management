import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.SUPABASE_DATABASE_URL) {
  throw new Error("SUPABASE_DATABASE_URL must be set to the Supabase connection string");
}

export default defineConfig({
  // drizzle-kit globs this path, so it needs forward slashes on Windows too.
  schema: path.join(__dirname, "./src/schema/index.ts").replaceAll("\\", "/"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.SUPABASE_DATABASE_URL,
  },
});
