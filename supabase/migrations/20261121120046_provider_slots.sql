-- Provider quota slots for external APIs without their own quota headers (docs/specs/city-tour.md 17.4,
-- "Transitous quota [P3]"). First user: Transitous `/plan` (public transport legs of a city tour).
--
-- provider_reserve_slot takes a transaction-level advisory lock per provider, counts the network calls of the last
-- 24 h in `api_calls` (cache <> 'hit', guard refusals excluded) plus unexpired, not yet done slots, refuses at the
-- daily cap, and refuses a second live slot for the same cache key (that caller waits for the cache: in-flight
-- dedupe). The caller marks the slot done after logging the call. An expired slot (process died) stops counting by
-- itself after 2 minutes. No slot, no request (fail closed, in the server code).
--
-- A slot holds no content: provider name, a hashed cache key and timestamps. RLS on, no policies: only the secret
-- key (service_role) reads and writes it. Slots older than 2 days are removed by the next reservation.

create table if not exists public.provider_slots (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  cache_key    text not null check (cache_key ~ '^[0-9a-f]{64}$'),
  reserved_at  timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '2 minutes',
  done         boolean not null default false
);

create index if not exists provider_slots_live_idx on public.provider_slots (provider, expires_at) where not done;

alter table public.provider_slots enable row level security;
revoke all on table public.provider_slots from anon, authenticated, public;
grant select, insert, update, delete on public.provider_slots to service_role;
-- No policies on purpose.

-- Returns {ok: true, id} or {ok: false, reason: 'cap' | 'in_flight'}.
create or replace function public.provider_reserve_slot(p_provider text, p_cache_key text, p_daily_cap integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_calls integer;
  v_live integer;
  v_id uuid;
begin
  if p_provider is null or p_cache_key is null or p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('provider_slots:' || p_provider, 0));

  delete from public.provider_slots where provider = p_provider and reserved_at < now() - interval '2 days';

  if exists (
    select 1 from public.provider_slots
     where provider = p_provider and cache_key = p_cache_key and not done and expires_at > now()
  ) then
    return jsonb_build_object('ok', false, 'reason', 'in_flight');
  end if;

  select count(*) into v_calls
    from public.api_calls
   where provider = p_provider
     and created_at > now() - interval '24 hours'
     and cache <> 'hit'
     and (error_code is null or error_code <> 'quota_guard');
  select count(*) into v_live
    from public.provider_slots
   where provider = p_provider and not done and expires_at > now();

  if v_calls + v_live >= p_daily_cap then
    return jsonb_build_object('ok', false, 'reason', 'cap');
  end if;

  insert into public.provider_slots (provider, cache_key) values (p_provider, p_cache_key) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- The call was logged in api_calls (which now counts it), so the slot stops counting.
create or replace function public.provider_settle_slot(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.provider_slots set done = true where id = p_id and not done;
$$;

revoke all on function public.provider_reserve_slot(text, text, integer) from public, anon, authenticated;
revoke all on function public.provider_settle_slot(uuid) from public, anon, authenticated;
grant execute on function public.provider_reserve_slot(text, text, integer) to service_role;
grant execute on function public.provider_settle_slot(uuid) to service_role;
