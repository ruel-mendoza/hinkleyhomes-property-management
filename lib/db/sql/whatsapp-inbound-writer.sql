-- Database login for the Supabase Edge Function "whatsapp-inbound"
-- (supabase/functions/whatsapp-inbound). It may only add rows to
-- whatsapp_messages: no reading, changing or deleting. The row policy in
-- lib/db/src/schema/messaging.ts enforces the same; the database push adds it.
--
-- Order:
--   1. Run the "create role" line below (replace the password first).
--   2. Run the database push (pnpm --filter @workspace/db run push), which adds
--      the whatsapp_messages table and its policy for this login.
--   3. Run the grant and policy lines (safe to run again). The push creates the
--      policy without its check (seen 27 Nov 2026), which blocks every insert.
--
-- Then add the Edge Function secret WHATSAPP_DB_URL (Supabase > Edge Functions
-- > Secrets), using the session pooler host from SUPABASE_DATABASE_URL:
--   postgresql://whatsapp_inbound_writer.<project ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres

create role whatsapp_inbound_writer with login password 'CHANGE-ME-to-a-long-random-password' nobypassrls;

grant usage on schema public to whatsapp_inbound_writer;
grant insert on table public.whatsapp_messages to whatsapp_inbound_writer;
alter policy whatsapp_messages_inbound_insert on public.whatsapp_messages with check (true);

-- The function uses plain "on conflict do nothing": naming the column needs read
-- access, which this login deliberately doesn't have.
