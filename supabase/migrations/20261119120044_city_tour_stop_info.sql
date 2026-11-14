-- City tour stop info (docs/specs/city-tour-stop-info.md sections 4, 5 and 12; issue #213). Forward-only and additive:
-- one nullable column on city_tours, a reservation table for the daily batch limits, and three functions for the
-- server (secret key only). The old app never reads the column, and a stop_info write does not move updated_at.

-- ---------- city_tours.stop_info ----------
-- TourStopInfo { v: 1, locale, stops: StopInfo[] } (spec 4), validated by Zod in the app; the database bounds shape and
-- size (128 kB: 27 entries at their Zod maxima stay below it). Written by the server only (no client grant), through public.merge_stop_info below.
alter table public.city_tours
  add column if not exists stop_info jsonb
    check (stop_info is null or (jsonb_typeof(stop_info) = 'object' and pg_column_size(stop_info) <= 131072));

-- ---------- helpers ----------
-- The point keys of a tour input: start, places, and an end place ("start" as end adds nothing). Never raises on a
-- malformed input (missing or non-array places give no keys).
create or replace function private.tour_point_keys(p_input jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(k), '{}'::text[]) from (
    select p_input #>> '{start,key}' as k
    union all
    select e ->> 'key'
      from jsonb_array_elements(case when jsonb_typeof(p_input -> 'places') = 'array' then p_input -> 'places' else '[]'::jsonb end) e
    union all
    select case when jsonb_typeof(p_input -> 'end') = 'object' then p_input #>> '{end,key}' end
  ) s
  where k is not null;
$$;

-- stop_info restricted to the given keys (entries of removed stops are dropped). Null stays null.
create or replace function private.prune_stop_info(p_info jsonb, p_keys text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_info is null then null else jsonb_set(
    p_info, '{stops}',
    coalesce((select jsonb_agg(e) from jsonb_array_elements(coalesce(p_info -> 'stops', '[]'::jsonb)) e
               where e ->> 'key' = any (p_keys)), '[]'::jsonb)) end;
$$;

-- ---------- updated_at only for real edits; removed stops lose their info in the same statement ----------
-- Before: every update moved updated_at. Now a write that changes only stop_info keeps it, so saveResult and
-- versioned edits (updated_at checks) see no conflict (spec 12). An input change prunes stop_info to the new points.
create or replace function private.city_tours_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.input is distinct from old.input and new.stop_info is not null then
    new.stop_info := private.prune_stop_info(new.stop_info, private.tour_point_keys(new.input));
  end if;
  if (new.title, new.input, new.trip_id, new.trip_day, new.result, new.result_hash, new.computed_at, new.owner_id)
     is distinct from
     (old.title, old.input, old.trip_id, old.trip_day, old.result, old.result_hash, old.computed_at, old.owner_id) then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists city_tours_set_updated_at on public.city_tours;
create trigger city_tours_set_updated_at
  before update on public.city_tours
  for each row execute function private.city_tours_before_update();

-- ---------- merge_stop_info: one atomic merge per batch ----------
-- Keeps stored entries, replaces or adds the fetched ones by key, drops entries whose key is no longer a point of
-- the row's CURRENT input (read in the same statement, so a late batch cannot restore a removed stop). The batch's
-- locale applies only when it equals the owner's current locale (profiles, same statement); a different stored
-- locale is replaced as a whole. Returns 'ok', 'stale_locale' (discarded) or 'not_found'.
create or replace function public.merge_stop_info(p_tour uuid, p_entries jsonb, p_locale text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
  v_owner uuid;
begin
  if p_tour is null or p_locale is null or p_locale not in ('de', 'en') or jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  select owner_id into v_owner from public.city_tours where id = p_tour;
  if v_owner is null then
    return 'not_found';
  end if;
  -- Hold the owner's profile row until commit, so a locale change cannot slip between the check and the write.
  perform 1 from public.profiles where id = v_owner for share;

  -- One UPDATE: under READ COMMITTED a concurrent merge on the same row is re-evaluated against the newer version.
  update public.city_tours t
     set stop_info = jsonb_build_object(
           'v', 1,
           'locale', p_locale,
           'stops', coalesce((
             select jsonb_agg(e order by e ->> 'key')
               from (
                 select e from jsonb_array_elements(
                   case when t.stop_info ->> 'locale' = p_locale then coalesce(t.stop_info -> 'stops', '[]'::jsonb)
                        else '[]'::jsonb end) e
                  where not exists (select 1 from jsonb_array_elements(p_entries) n where n ->> 'key' = e ->> 'key')
                 union all
                 -- One entry per key from the batch (the last one wins).
                 (select distinct on (n ->> 'key') n
                    from jsonb_array_elements(p_entries) with ordinality as x(n, i)
                   order by n ->> 'key', i desc)
               ) m(e)
              where e ->> 'key' = any (private.tour_point_keys(t.input))
           ), '[]'::jsonb))
   where t.id = p_tour
     and p_locale = (select p.locale from public.profiles p where p.id = t.owner_id);
  get diagnostics v_rows = row_count;
  if v_rows = 1 then
    return 'ok';
  end if;
  -- Nothing updated: the tour was deleted meanwhile, or the locale no longer matches.
  return case when exists (select 1 from public.city_tours where id = p_tour) then 'stale_locale' else 'not_found' end;
end;
$$;

-- ---------- daily batch limits, reserved (spec 12) ----------
-- One row per batch: who triggered it (a user, or a share link) and when. Pending rows (settled_at null) older than
-- 2 minutes no longer count (a batch that died). RLS on, no policies: secret key only. Rows older than 2 days are
-- removed by the next reservation.
create table if not exists public.stop_info_slots (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users (id) on delete cascade,
  -- No foreign key: deleting a share link must not delete its settled slots (they keep counting app-wide today).
  link_id     uuid,
  created_at  timestamptz not null default now(),
  settled_at  timestamptz,
  constraint stop_info_slots_one_scope check ((user_id is null) <> (link_id is null))
);

create index if not exists stop_info_slots_user_idx on public.stop_info_slots (user_id, created_at desc) where user_id is not null;
create index if not exists stop_info_slots_link_idx on public.stop_info_slots (link_id, created_at desc) where link_id is not null;
create index if not exists stop_info_slots_created_idx on public.stop_info_slots (created_at desc);

alter table public.stop_info_slots enable row level security;
revoke all on table public.stop_info_slots from anon, authenticated, public;
grant select, insert, update, delete on public.stop_info_slots to service_role;
-- No policies on purpose.

-- Takes one slot when the scope's and the app-wide day limits allow it. Exactly one of p_user / p_link.
-- Returns {ok: true, id} or {ok: false, reason: 'scope' | 'app'}.
create or replace function public.stop_info_reserve(
  p_user uuid, p_link uuid, p_scope_limit integer, p_app_limit integer, p_day_start timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope integer;
  v_app integer;
  v_id uuid;
begin
  if (p_user is null) = (p_link is null) or p_scope_limit is null or p_app_limit is null or p_day_start is null then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  -- App-wide lock first, then the scope: every reservation takes them in the same order (no deadlock).
  perform pg_advisory_xact_lock(hashtextextended('stop_info_slots:app', 0));
  perform pg_advisory_xact_lock(hashtextextended('stop_info_slots:' || coalesce(p_user::text, 'link:' || p_link::text), 0));

  delete from public.stop_info_slots where created_at < now() - interval '2 days';

  select count(*) into v_app from public.stop_info_slots
   where created_at >= p_day_start and (settled_at is not null or created_at > now() - interval '2 minutes');
  select count(*) into v_scope from public.stop_info_slots
   where created_at >= p_day_start and (settled_at is not null or created_at > now() - interval '2 minutes')
     and (user_id = p_user or link_id = p_link);

  if v_scope >= p_scope_limit then
    return jsonb_build_object('ok', false, 'reason', 'scope');
  end if;
  if v_app >= p_app_limit then
    return jsonb_build_object('ok', false, 'reason', 'app');
  end if;

  insert into public.stop_info_slots (user_id, link_id) values (p_user, p_link) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- The batch ran (requests were sent): the slot keeps counting.
create or replace function public.stop_info_settle(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.stop_info_slots set settled_at = now() where id = p_id and settled_at is null;
$$;

-- The batch sent nothing (everything cached, or it was cancelled): give the slot back.
create or replace function public.stop_info_release(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.stop_info_slots where id = p_id and settled_at is null;
$$;

revoke all on function public.merge_stop_info(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.stop_info_reserve(uuid, uuid, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.stop_info_settle(uuid) from public, anon, authenticated;
revoke all on function public.stop_info_release(uuid) from public, anon, authenticated;
grant execute on function public.merge_stop_info(uuid, jsonb, text) to service_role;
grant execute on function public.stop_info_reserve(uuid, uuid, integer, integer, timestamptz) to service_role;
grant execute on function public.stop_info_settle(uuid) to service_role;
grant execute on function public.stop_info_release(uuid) to service_role;
