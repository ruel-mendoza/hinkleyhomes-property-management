-- Database login for the n8n "Telleroo events" workflow. It saves Telleroo
-- webhooks and pay run status in Supabase itself (the app may be asleep), and may only:
--   telleroo_events     add (every webhook as it arrived)
--   telleroo_pay_runs   read, add and update (latest state of each pay run)
-- Row policies in lib/db/src/schema/telleroo.ts enforce the same; the database push adds them.
--
-- Run in Supabase > SQL Editor. Replace the password first and keep it only in
-- the n8n Postgres credential "Postgres (Telleroo)". The grants need the tables,
-- so run the database push first if they don't exist yet. Already created the
-- login? Run just the grant lines (safe to run again).
--
-- n8n Postgres credential (Supabase session pooler):
--   Host:     aws-0-<region>.pooler.supabase.com   (as in SUPABASE_DATABASE_URL)
--   Port:     5432
--   Database: postgres
--   User:     n8n_telleroo_writer.<project ref>
--   SSL:      require, with "Ignore SSL Issues" on

create role n8n_telleroo_writer with login password 'CHANGE-ME-to-a-long-random-password' nobypassrls;

grant usage on schema public to n8n_telleroo_writer;
grant insert on table public.telleroo_events to n8n_telleroo_writer;
grant select, insert, update on table public.telleroo_pay_runs to n8n_telleroo_writer;
