-- Background retries for place lookups that failed or timed out (docs/specs/activities-and-restaurants.md,
-- addendum 2). A job lives at most 30 minutes (give_up_at = created_at + 30 min, enforced by a check), then it is
-- 'gave_up'. pg_cron calls GET /api/cron/place-retries through pg_net every 5 minutes.
--
-- The table holds no user content: lookup kind, normalized parameters (coordinates, radius, group or interest key)
-- and a dedupe key. RLS is on and there are NO policies: only the secret key (service_role) reads and writes it.

create table if not exists public.place_retry_jobs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('interest', 'activity_group', 'restaurants', 'cafes')),
  -- Normalized lookup parameters (RetrySpec in src/lib/places-retry.ts); never user content.
  params      jsonb not null check (jsonb_typeof(params) = 'object' and pg_column_size(params) <= 1000),
  cache_key   text not null check (char_length(cache_key) between 1 and 200),
  status      text not null default 'queued' check (status in ('queued', 'done', 'gave_up')),
  attempts    smallint not null default 0 check (attempts between 0 and 100),
  last_error  text check (char_length(last_error) <= 60),
  created_at  timestamptz not null default now(),
  give_up_at  timestamptz not null default (now() + interval '30 minutes'),
  -- Lease taken by place_retry_claim so overlapping worker runs never take the same job.
  lease_until timestamptz,
  updated_at  timestamptz not null default now(),
  constraint place_retry_jobs_window check (give_up_at = created_at + interval '30 minutes')
);

-- Dedupe: one queued job per lookup. A re-enqueue of a queued key is ignored (and so never extends give_up_at).
create unique index if not exists place_retry_jobs_queued_key_idx on public.place_retry_jobs (cache_key) where status = 'queued';
create index if not exists place_retry_jobs_queued_idx on public.place_retry_jobs (created_at) where status = 'queued';
create index if not exists place_retry_jobs_updated_idx on public.place_retry_jobs (updated_at);

alter table public.place_retry_jobs enable row level security;
revoke all on table public.place_retry_jobs from anon, authenticated, public;
grant select, insert, update, delete on public.place_retry_jobs to service_role;
-- No policies on purpose.

drop trigger if exists place_retry_jobs_set_updated_at on public.place_retry_jobs;
create trigger place_retry_jobs_set_updated_at
  before update on public.place_retry_jobs
  for each row execute function private.set_updated_at();

-- The retry window is fixed at creation: created_at and give_up_at never change afterwards.
create or replace function private.place_retry_window_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.created_at is distinct from old.created_at or new.give_up_at is distinct from old.give_up_at then
    raise exception 'created_at and give_up_at are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.place_retry_window_guard() from public, anon, authenticated;

drop trigger if exists place_retry_jobs_window_guard on public.place_retry_jobs;
create trigger place_retry_jobs_window_guard
  before update on public.place_retry_jobs
  for each row execute function private.place_retry_window_guard();

-- ---------- place_retry_enqueue: insert jobs, ignoring keys that are already queued ----------
-- p_jobs = [{kind, cache_key, params}, ...] (at most 20). Returns the number of new jobs. Keys already queued, or
-- given up within the last 6 hours, are skipped.
create or replace function public.place_retry_enqueue(p_jobs jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if p_jobs is null or jsonb_typeof(p_jobs) <> 'array' or jsonb_array_length(p_jobs) > 20 then
    raise exception 'invalid jobs' using errcode = '22023';
  end if;
  insert into public.place_retry_jobs (kind, cache_key, params)
  select j.kind, j.cache_key, j.params
    from jsonb_to_recordset(p_jobs) as j(kind text, cache_key text, params jsonb)
   -- Cooldown: a search that was given up less than 6 hours ago is not queued again, so repeated user actions
   -- cannot keep one search retrying for ever.
   where not exists (
           select 1 from public.place_retry_jobs g
            where g.cache_key = j.cache_key and g.status = 'gave_up' and g.updated_at > now() - interval '6 hours')
  on conflict (cache_key) where status = 'queued' do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------- place_retry_claim: lease due jobs, oldest first ----------
create or replace function public.place_retry_claim(p_limit integer, p_lease_seconds integer)
returns setof public.place_retry_jobs
language sql
security definer
set search_path = ''
as $$
  update public.place_retry_jobs j
     set lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 1))
   where j.id in (
           select q.id
             from public.place_retry_jobs q
            where q.status = 'queued'
              and q.give_up_at > now()
              and (q.lease_until is null or q.lease_until <= now())
            order by q.created_at
            limit greatest(least(p_limit, 20), 0)
            for update skip locked)
  returning j.*;
$$;

revoke all on function public.place_retry_enqueue(jsonb) from public, anon, authenticated;
revoke all on function public.place_retry_claim(integer, integer) from public, anon, authenticated;
grant execute on function public.place_retry_enqueue(jsonb) to service_role;
grant execute on function public.place_retry_claim(integer, integer) to service_role;

-- ---------- pg_net and Vault (guarded: the local/CI stack may not ship them) ----------
do $$
begin
  create extension if not exists pg_net with schema extensions;
exception when others then
  raise notice 'pg_net not available (%): place retries will not be triggered here', sqlerrm;
end
$$;

do $$
begin
  create extension if not exists supabase_vault;
exception when others then
  raise notice 'supabase_vault not available (%): place retries will not be triggered here', sqlerrm;
end
$$;

-- ---------- private.run_place_retries: the cron body ----------
-- 1. Deletes finished rows older than 7 days.
-- 2. Does nothing while no job is queued (no HTTP call, no cost).
-- 3. Reads app_base_url and cron_secret from Vault and calls the route. If either is missing, or pg_net / Vault do not
--    exist, it logs places.retry_cron_unconfigured (at most once an hour) and returns false. It never raises, so a
--    missing secret cannot fail a deploy or the cron job.
-- The secret never appears in a migration: it lives in Vault (see docs/runbook.md).
create or replace function private.run_place_retries()
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_expired integer;
  v_url    text;
  v_secret text;
  v_reason text;
begin
  delete from public.place_retry_jobs where status <> 'queued' and updated_at < now() - interval '7 days';

  -- Expire in the database too, so the 30-minute limit holds even if the route never runs.
  update public.place_retry_jobs set status = 'gave_up', lease_until = null
   where status = 'queued' and give_up_at <= now();
  get diagnostics v_expired = row_count;
  if v_expired > 0 then
    insert into public.app_events (event, level, props)
    values ('places.retry_gave_up', 'warn', jsonb_build_object('reason', 'window', 'count', v_expired));
  end if;

  if not exists (select 1 from public.place_retry_jobs where status = 'queued') then
    return false;
  end if;

  if to_regclass('vault.decrypted_secrets') is null then
    v_reason := 'no_vault';
  elsif to_regprocedure('net.http_get(text,jsonb,jsonb,integer)') is null then
    v_reason := 'no_pg_net';
  else
    begin
      execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'app_base_url' limit 1$q$ into v_url;
      execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1$q$ into v_secret;
    exception when others then
      v_reason := 'vault_error';
    end;
    if v_reason is null and (coalesce(v_url, '') = '' or coalesce(v_secret, '') = '') then
      v_reason := 'no_secret';
    end if;
  end if;

  if v_reason is not null then
    if not exists (
      select 1 from public.app_events
       where event = 'places.retry_cron_unconfigured' and created_at > now() - interval '1 hour'
    ) then
      insert into public.app_events (event, level, props)
      values ('places.retry_cron_unconfigured', 'warn', jsonb_build_object('reason', v_reason));
    end if;
    return false;
  end if;

  begin
    perform net.http_get(
      url := rtrim(v_url, '/') || '/api/cron/place-retries',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret),
      timeout_milliseconds := 290000
    );
  exception when others then
    insert into public.app_events (event, level, props)
    values ('places.retry_cron_failed', 'error', jsonb_build_object('error', left(sqlstate, 10)));
    return false;
  end;
  return true;
end;
$$;

revoke all on function private.run_place_retries() from public, anon, authenticated;

-- Every 5 minutes. cron.schedule upserts by job name. Guarded like the other extensions: pg_cron is created by
-- 20261029120014_trip_retention.sql; if it is missing, the job is skipped.
do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.schedule('place-retries', '*/5 * * * *', 'select private.run_place_retries()');
  else
    raise notice 'pg_cron not available: place-retries job not scheduled';
  end if;
end
$$;
