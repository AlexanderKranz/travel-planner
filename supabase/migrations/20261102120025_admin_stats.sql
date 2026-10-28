-- Phase 6 admin page + budget cron (spec docs/specs/phase-6-admin.md).
-- Aggregate functions so no raw rows leave the database. Every function is executable by service_role ONLY
-- (called with the secret key from src/lib/server/admin/stats.ts after a server-side admin check), exactly like
-- public.ai_spend_micro_usd. They return jsonb: counts, sums and percentiles, never user ids or content.
-- Day and month boundaries are passed in by the caller (Europe/Berlin midnights, see berlinMidnight()).

-- ---------- api_calls.variant: which Overpass mirror answered (host name, no query data) ----------
alter table public.api_calls
  add column if not exists variant text check (variant ~ '^[a-z0-9.-]+$' and char_length(variant) <= 60);

-- ---------- users ----------
-- SECURITY DEFINER because it reads auth.users (last_sign_in_at). Fixed search_path, everything qualified.
-- "Active" = signed in, or created a trip/plan/etc. (any app_events row of their own except share views) in the window.
-- The demo account is excluded from the user counts and reported separately.
create or replace function public.admin_user_stats(p_now timestamptz, p_month_start timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'total',          count(*) filter (where not p.is_demo),
    'admins',         count(*) filter (where p.role = 'admin'),
    'active7',        count(*) filter (where not p.is_demo and (
                        u.last_sign_in_at >= p_now - interval '7 days'
                        or exists (select 1 from public.app_events e
                                   where e.user_id = p.id and e.event <> 'share.viewed' and e.created_at >= p_now - interval '7 days'))),
    'active30',       count(*) filter (where not p.is_demo and (
                        u.last_sign_in_at >= p_now - interval '30 days'
                        or exists (select 1 from public.app_events e
                                   where e.user_id = p.id and e.event <> 'share.viewed' and e.created_at >= p_now - interval '30 days'))),
    'newThisMonth',   count(*) filter (where not p.is_demo and u.created_at >= p_month_start),
    'demoLogins7',    (select count(*) from public.app_events where event = 'auth.demo_login' and created_at >= p_now - interval '7 days'),
    'demoLogins30',   (select count(*) from public.app_events where event = 'auth.demo_login' and created_at >= p_now - interval '30 days'),
    'demoAiCallsMonth', (select count(*) from public.ai_usage where is_demo and created_at >= p_month_start),
    'demoAiMicroUsdMonth', (select coalesce(sum(cost_micro_usd), 0) from public.ai_usage where is_demo and created_at >= p_month_start)
  )
  from public.profiles p
  join auth.users u on u.id = p.id;
$$;

-- ---------- trips and plans ----------
create or replace function public.admin_usage_stats(p_month_start timestamptz, p_days integer default 14)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with days as (
    select d::date as day
    from generate_series(
      (now() at time zone 'Europe/Berlin')::date - (least(greatest(p_days, 1), 90) - 1),
      (now() at time zone 'Europe/Berlin')::date,
      interval '1 day') as d
  ),
  per_day as (
    select (v.created_at at time zone 'Europe/Berlin')::date as day,
           count(*) filter (where v.kind = 'generate') as generated,
           count(*) filter (where v.kind = 'patch') as patched
    from public.plan_versions v
    where v.created_at >= (select min(day) from days)::timestamp at time zone 'Europe/Berlin'
    group by 1
  )
  select jsonb_build_object(
    'trips',           (select count(*) from public.trips),
    'tripsThisMonth',  (select count(*) from public.trips where created_at >= p_month_start),
    'plans',           (select count(*) from public.plans),
    'versionsGenerate', (select count(*) from public.plan_versions where kind = 'generate'),
    'versionsPatch',   (select count(*) from public.plan_versions where kind = 'patch'),
    'generatedThisMonth', (select count(*) from public.plan_versions where kind = 'generate' and created_at >= p_month_start),
    'patchedThisMonth',   (select count(*) from public.plan_versions where kind = 'patch' and created_at >= p_month_start),
    'shareLinksActive', (select count(*) from public.share_links where expires_at is null or expires_at > now()),
    'perDay', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'day', to_char(days.day, 'YYYY-MM-DD'),
               'generated', coalesce(per_day.generated, 0),
               'patched', coalesce(per_day.patched, 0)) order by days.day), '[]'::jsonb)
      from days left join per_day using (day))
  );
$$;

-- ---------- AI cost ----------
create or replace function public.admin_ai_stats(p_day_start timestamptz, p_month_start timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with m as (select * from public.ai_usage where created_at >= p_month_start)
  select jsonb_build_object(
    'todayMicroUsd',  coalesce((select sum(cost_micro_usd) from m where created_at >= p_day_start), 0),
    'monthMicroUsd',  coalesce((select sum(cost_micro_usd) from m), 0),
    'callsMonth',     (select count(*) from m),
    'failedMonth',    (select count(*) from m where status <> 'ok'),
    'inputTokens',    coalesce((select sum(input_tokens) from m), 0),
    'cacheReadTokens', coalesce((select sum(cache_read_input_tokens) from m), 0),
    'cacheCreationTokens', coalesce((select sum(cache_creation_input_tokens) from m), 0),
    'outputTokens',   coalesce((select sum(output_tokens) from m), 0),
    'byTask', coalesce((select jsonb_agg(jsonb_build_object('key', task, 'calls', calls, 'microUsd', micro) order by micro desc)
                        from (select task, count(*) as calls, sum(cost_micro_usd) as micro from m group by task) t), '[]'::jsonb),
    'byModel', coalesce((select jsonb_agg(jsonb_build_object('key', model, 'calls', calls, 'microUsd', micro) order by micro desc)
                         from (select model, count(*) as calls, sum(cost_micro_usd) as micro from m group by model) t), '[]'::jsonb)
  );
$$;

-- ---------- external APIs ----------
-- Calls include cache hits; "network" = cache <> 'hit' (a request actually left the server). Latency percentiles
-- cover successful network calls only. Error rate = failed rows / network rows.
create or replace function public.admin_api_stats(p_day_start timestamptz, p_month_start timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with m as (select * from public.api_calls where created_at >= p_month_start)
  select jsonb_build_object(
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', provider,
        'callsToday', callsToday,
        'callsMonth', callsMonth,
        'networkToday', networkToday,
        'networkMonth', networkMonth,
        'errorsMonth', errorsMonth,
        'p50Ms', p50,
        'p95Ms', p95,
        'unitsToday', unitsToday,
        'unitsMonth', unitsMonth) order by provider)
      from (
        select provider,
               count(*) filter (where created_at >= p_day_start) as callsToday,
               count(*) as callsMonth,
               count(*) filter (where created_at >= p_day_start and cache <> 'hit') as networkToday,
               count(*) filter (where cache <> 'hit') as networkMonth,
               count(*) filter (where not ok) as errorsMonth,
               (percentile_cont(0.5) within group (order by latency_ms) filter (where ok and cache <> 'hit' and latency_ms is not null))::int as p50,
               (percentile_cont(0.95) within group (order by latency_ms) filter (where ok and cache <> 'hit' and latency_ms is not null))::int as p95,
               coalesce(sum(units) filter (where created_at >= p_day_start), 0) as unitsToday,
               coalesce(sum(units), 0) as unitsMonth
        from m group by provider) t), '[]'::jsonb),
    'aerodataboxQuotaRemaining', (
      select quota_remaining from public.api_calls
      where provider = 'aerodatabox' and quota_remaining is not null
      order by created_at desc limit 1),
    'overpassVariants', coalesce((
      select jsonb_agg(jsonb_build_object('variant', coalesce(variant, 'unknown'), 'calls', calls, 'errors', errors) order by calls desc)
      from (select variant, count(*) as calls, count(*) filter (where not ok) as errors
            from m where provider = 'overpass' and cache <> 'hit' group by variant) t), '[]'::jsonb)
  );
$$;

-- ---------- recent warnings and errors ----------
-- Event name, level, route, time and a short reason class only: no user id, no request id, no props.
create or replace function public.admin_recent_events(p_limit integer default 50)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'at', created_at, 'level', level, 'event', event, 'route', route,
           'code', left(coalesce(props ->> 'reason', props ->> 'code', props ->> 'error', props ->> 'kind'), 60)) order by created_at desc), '[]'::jsonb)
  from (
    select * from public.app_events
    where level in ('error', 'warn')
    order by created_at desc
    limit least(greatest(p_limit, 1), 100)
  ) e;
$$;

revoke all on function public.admin_user_stats(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_usage_stats(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.admin_ai_stats(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_api_stats(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_recent_events(integer) from public, anon, authenticated;
grant execute on function public.admin_user_stats(timestamptz, timestamptz) to service_role;
grant execute on function public.admin_usage_stats(timestamptz, integer) to service_role;
grant execute on function public.admin_ai_stats(timestamptz, timestamptz) to service_role;
grant execute on function public.admin_api_stats(timestamptz, timestamptz) to service_role;
grant execute on function public.admin_recent_events(integer) to service_role;
