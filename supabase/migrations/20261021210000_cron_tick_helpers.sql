-- Opt-in, free near-real-time scheduler: Supabase pg_cron + pg_net calling /api/cron/tick.
--
-- This migration only creates two helper functions; it schedules NOTHING by itself.
-- To turn it on (Supabase SQL editor, after enabling the pg_cron and pg_net extensions):
--
--   select vault.create_secret('<same value as CRON_SECRET on Vercel>', 'email_boss_cron_secret');
--   select email_boss.enable_cron_tick('https://<your-email-boss-deployment>/api/cron/tick');
--
-- Turn it off:   select email_boss.disable_cron_tick();
-- Inspect:       select * from cron.job where jobname = 'email-boss-tick';
--                select * from net._http_response order by created desc limit 10;
--
-- The secret is read from Supabase Vault at run time, so it never appears in cron.job.
-- The Vercel daily cron in vercel.json stays as a fallback; overlapping runs are safe.

create or replace function email_boss.enable_cron_tick(p_url text, p_schedule text default '* * * * *')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job bigint;
begin
  if p_url is null or p_url !~ '^https://[^/\s]+/api/cron/tick$' then
    raise exception 'p_url must look like https://<host>/api/cron/tick';
  end if;
  if to_regnamespace('cron') is null or to_regnamespace('net') is null then
    raise exception 'enable the pg_cron and pg_net extensions first (Database > Extensions)';
  end if;
  if to_regnamespace('vault') is null then
    raise exception 'Supabase Vault is required to store the cron secret';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'email_boss_cron_secret') then
    raise exception 'create the secret first: select vault.create_secret(''<CRON_SECRET>'', ''email_boss_cron_secret'');';
  end if;

  perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'email-boss-tick';

  select cron.schedule(
    'email-boss-tick',
    p_schedule,
    format(
      $cmd$select net.http_get(
        url := %L,
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'email_boss_cron_secret')
        ),
        timeout_milliseconds := 55000
      )$cmd$,
      p_url
    )
  ) into v_job;
  return v_job;
end $$;

create or replace function email_boss.disable_cron_tick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regnamespace('cron') is null then
    return;
  end if;
  perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'email-boss-tick';
end $$;

revoke all on function email_boss.enable_cron_tick(text, text) from public;
revoke all on function email_boss.disable_cron_tick() from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function email_boss.enable_cron_tick(text, text) from %I', r);
      execute format('revoke all on function email_boss.disable_cron_tick() from %I', r);
    end if;
  end loop;
end $$;
