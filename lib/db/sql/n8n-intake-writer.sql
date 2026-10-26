-- Database login for the n8n "Hinkley Intake check" workflow. It keeps all its
-- data in Supabase itself (the app may be asleep), and may only:
--   invoice_intake_checks   read and add (its log of checked emails)
--   document_readings       read and add (AI readings, shared with bill coding)
--   company_aliases         read (names invoices may be addressed to)
--   invoice_intake_reviews  add new open reviews (Invoices > For review)
--   invoice_intake_files    add (SharePoint file and invoice links per email)
-- Row policies in lib/db/src/schema enforce the same; the database push adds them.
--
-- Run in Supabase > SQL Editor. Replace the password first and keep it only in
-- the n8n Postgres credential. The grants need the tables, so run the database
-- push first if they don't exist yet. Already created the login? Run just the
-- grant lines (safe to run again).
--
-- n8n Postgres credential (Supabase session pooler):
--   Host:     aws-0-<region>.pooler.supabase.com   (as in SUPABASE_DATABASE_URL)
--   Port:     5432
--   Database: postgres
--   User:     n8n_intake_writer.<project ref>
--   SSL:      require, with "Ignore SSL Issues" on
--   ****

create role n8n_intake_writer with login password 'CHANGE-ME-to-a-long-random-password' nobypassrls;

grant usage on schema public to n8n_intake_writer;
grant insert on table public.invoice_intake_reviews to n8n_intake_writer;
grant select, insert on table public.invoice_intake_checks to n8n_intake_writer;
grant select, insert on table public.document_readings to n8n_intake_writer;
grant select on table public.company_aliases to n8n_intake_writer;
grant insert on table public.invoice_intake_files to n8n_intake_writer;
