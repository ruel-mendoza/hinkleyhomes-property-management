-- Database login for the n8n "Hinkley Intake check" workflow. It saves the
-- emails it sends for review straight into invoice_intake_reviews (the app may
-- be asleep), and can do nothing else: insert new open rows into that one table.
--
-- Run once in Supabase > SQL Editor, BEFORE the database push (the push adds
-- the row policy, which names this login). Replace the password first and keep
-- it only in the n8n Postgres credential.
--
-- n8n Postgres credential (Supabase session pooler):
--   Host:     aws-0-<region>.pooler.supabase.com   (as in SUPABASE_DATABASE_URL)
--   Port:     5432
--   Database: postgres
--   User:     n8n_intake_writer.<project ref>
--   SSL:      require

create role n8n_intake_writer with login password 'CHANGE-ME-to-a-long-random-password' nobypassrls;

grant usage on schema public to n8n_intake_writer;
grant insert on table public.invoice_intake_reviews to n8n_intake_writer;
