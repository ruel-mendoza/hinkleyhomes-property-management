import { pgRole } from "drizzle-orm/pg-core";

// Database login for the n8n "Hinkley Intake check" workflow, which keeps its
// data in these tables itself (the app may be asleep). Row policies on each
// table say what it may do; create the login and its grants first with
// lib/db/sql/n8n-intake-writer.sql.
export const n8nIntakeWriterRole = pgRole("n8n_intake_writer").existing();
