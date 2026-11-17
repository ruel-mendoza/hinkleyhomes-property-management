-- Scheduled syncs run by Supabase (pg_cron + pg_net) instead of n8n.
--
-- These five jobs only wake the PMS and ask it to run a sync. In n8n each run
-- counted towards the monthly execution limit; here they're free. The PMS
-- endpoints are the same ones n8n called (POST, header X-Hinkley-Sync-Key).
--
-- pg_cron runs in UTC, but the office hours are UK time, so the jobs fire every
-- hour and private.pms_call() skips any run outside the UK hours it's given.
-- That keeps 7am-7pm correct across the clocks changing.
--
-- Run once in the Supabase SQL editor (Database > SQL editor):
--   1. Replace the two values in step 1 (the PMS address and PMS_SYNC_KEY from
--      Replit Secrets). They're stored encrypted in Supabase Vault.
--   2. Run the whole file. Re-running it is safe: it replaces the jobs.
--   3. Switch off these n8n workflows (keep them, just deactivate):
--      COHO actions sync, COHO unit snapshot, Rent ready to match in COHO,
--      Xero daily checks. In "Smoobu sync (webhook + hourly)" delete only the
--      schedule trigger: the Smoobu webhook part must stay in n8n.
--
-- Check it's working:
--   select jobname, schedule, active from cron.job where jobname like 'pms-%';
--   select * from cron.job_run_details order by start_time desc limit 20;
--   select id, status_code, left(content, 200), error_msg, created
--     from net._http_response order by created desc limit 20;
-- To stop one: select cron.unschedule('pms-coho-actions-sync');

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1. Secrets (replace the values, then run). Vault keeps them encrypted.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'pms_base_url') then
    perform vault.create_secret('https://hinkleyhomes-property-management.replit.app', 'pms_base_url', 'PMS address for scheduled syncs');
  end if;
  if not exists (select 1 from vault.secrets where name = 'pms_sync_key') then
    perform vault.create_secret('REPLACE-WITH-PMS_SYNC_KEY', 'pms_sync_key', 'PMS_SYNC_KEY for scheduled syncs');
  end if;
end $$;
-- To change a value later:
--   select vault.update_secret((select id from vault.secrets where name = 'pms_sync_key'), 'new value');

-- 2. One function that calls a PMS endpoint, only inside the given UK hours and days.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.pms_call(
  path text,
  uk_hours int[] default null,      -- e.g. '{7,8,...,19}'; null = any hour
  uk_weekdays int[] default null,   -- ISO days, 1 = Monday ... 7 = Sunday; null = every day
  timeout_ms int default 300000
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  uk timestamp := now() at time zone 'Europe/London';
  base_url text;
  sync_key text;
begin
  if uk_hours is not null and not (extract(hour from uk)::int = any (uk_hours)) then return null; end if;
  if uk_weekdays is not null and not (extract(isodow from uk)::int = any (uk_weekdays)) then return null; end if;

  select decrypted_secret into base_url from vault.decrypted_secrets where name = 'pms_base_url';
  select decrypted_secret into sync_key from vault.decrypted_secrets where name = 'pms_sync_key';
  if base_url is null or sync_key is null or sync_key like 'REPLACE-%' then
    raise exception 'Set the pms_base_url and pms_sync_key secrets in Supabase Vault first';
  end if;

  return net.http_post(
    url := rtrim(base_url, '/') || path,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Hinkley-Sync-Key', sync_key),
    timeout_milliseconds := timeout_ms
  );
end;
$$;
revoke all on function private.pms_call(text, int[], int[], int) from public, anon, authenticated;

-- 3. The jobs (same times as the n8n workflows they replace, UK time).
select cron.unschedule(jobname) from cron.job where jobname in (
  'pms-coho-actions-sync', 'pms-rent-match-actions', 'pms-smoobu-sync', 'pms-coho-unit-snapshot', 'pms-xero-daily-checks'
);

-- COHO actions mirror: hourly 7am-7pm, every day.
select cron.schedule('pms-coho-actions-sync', '0 * * * *',
  $$select private.pms_call('/api/integrations/coho/actions/sync', array[7,8,9,10,11,12,13,14,15,16,17,18,19], null, 120000)$$);

-- Rent ready to match in COHO: hourly at :15, 7am-7pm, Monday to Saturday.
select cron.schedule('pms-rent-match-actions', '15 * * * *',
  $$select private.pms_call('/api/integrations/coho/rent-match-actions', array[7,8,9,10,11,12,13,14,15,16,17,18,19], array[1,2,3,4,5,6], 120000)$$);

-- Smoobu catch-up sync: every 3 hours (the Smoobu webhook stays in n8n).
select cron.schedule('pms-smoobu-sync', '30 */3 * * *',
  $$select private.pms_call('/api/integrations/smoobu/sync', null, null, 300000)$$);

-- COHO unit snapshot: daily at 11:30pm UK.
select cron.schedule('pms-coho-unit-snapshot', '30 22,23 * * *',
  $$select private.pms_call('/api/integrations/coho/unit-snapshot', array[23], null, 120000)$$);

-- Xero daily checks: daily at 8am UK. Its Xero reads still go through the n8n gateway.
select cron.schedule('pms-xero-daily-checks', '0 7,8 * * *',
  $$select private.pms_call('/api/integrations/xero/daily-checks', array[8], null, 600000)$$);
