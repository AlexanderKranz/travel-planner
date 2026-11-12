-- City tours (docs/specs/city-tour.md section 9, ADR 0012, decisions [T1] [T14] [T15] [T18]). Forward-only and
-- additive: a new table, a date helper and one more step in the nightly purge. The old app never reads the table.

-- ---------- city_tours ----------
-- A tour lives on its own; it may be linked to a day of an OWN trip. The input is the TourInput (spec 3.2) and the
-- result the TourResult snapshot (spec 9.2), both validated by Zod in the app. The database only bounds shape and size.
create table if not exists public.city_tours (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text check (title is null or char_length(title) <= 120),
  input       jsonb not null check (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 16384),
  trip_id     uuid,
  -- Ignored by code when trip_id is null. May exceed the trip's length after the trip is shortened ("Ohne Tag").
  trip_day    smallint check (trip_day between 1 and 60),
  -- Written by the server only (secret key, after an RLS read): no client grant on these three columns [T14].
  result      jsonb check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 262144)),
  -- sha256 (hex) of the normalized input that produced result.
  result_hash text check (result_hash is null or result_hash ~ '^[0-9a-f]{64}$'),
  computed_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint city_tours_id_owner_key unique (id, owner_id),
  -- Same-owner link: a tour cannot point at another user's trip (also not a trip shared with its owner). Deleting the
  -- trip clears only trip_id; the tour stays as a standalone tour with its owner. trips_id_owner_key exists since
  -- 20261030120016_plans.sql.
  constraint city_tours_trip_fkey foreign key (trip_id, owner_id)
    references public.trips (id, owner_id) on delete set null (trip_id)
);

create index if not exists city_tours_owner_updated_idx on public.city_tours (owner_id, updated_at desc);
create index if not exists city_tours_trip_day_idx on public.city_tours (trip_id, trip_day) where trip_id is not null;

drop trigger if exists city_tours_set_updated_at on public.city_tours;
create trigger city_tours_set_updated_at
  before update on public.city_tours
  for each row execute function private.set_updated_at();

alter table public.city_tours enable row level security;

-- ---------- grants ----------
-- owner_id comes from its default (auth.uid()); result, result_hash and computed_at are not user-writable, so a direct
-- PostgREST call cannot put a fake "verified" route on a share page [T14].
revoke all on table public.city_tours from anon, authenticated, public;
grant select, delete on public.city_tours to authenticated;
grant insert (title, input, trip_id, trip_day) on public.city_tours to authenticated;
grant update (title, input, trip_id, trip_day) on public.city_tours to authenticated;
grant select, insert, update, delete on public.city_tours to service_role;

-- ---------- policies ----------
drop policy if exists "city_tours: owner select" on public.city_tours;
create policy "city_tours: owner select" on public.city_tours
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists "city_tours: owner insert" on public.city_tours;
create policy "city_tours: owner insert" on public.city_tours
  for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists "city_tours: owner update" on public.city_tours;
create policy "city_tours: owner update" on public.city_tours
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
drop policy if exists "city_tours: owner delete" on public.city_tours;
create policy "city_tours: owner delete" on public.city_tours
  for delete to authenticated using (owner_id = (select auth.uid()));

-- Grantees of a trip (read AND write) see the tours linked to it, read-only, like the trip's group and purpose
-- [T15]. No grantee insert, update or delete policy. private.shared_trip_ids() hides trips of disabled owners.
drop policy if exists "city_tours: trip grantee select" on public.city_tours;
create policy "city_tours: trip grantee select" on public.city_tours
  for select to authenticated using (trip_id = any ((select private.shared_trip_ids())::uuid[]));

-- ---------- retention helper ----------
-- 'YYYY-MM-DD' to date, or null for anything else (absent, wrong shape, impossible date like 2026-02-30). Never
-- raises, so a malformed input->>'date' cannot fail the nightly purge.
create or replace function private.iso_date_or_null(p_value text)
returns date
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_value is null or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  return p_value::date;
exception
  when data_exception then
    return null;
end;
$$;

revoke all on function private.iso_date_or_null(text) from public, anon, authenticated;

-- ---------- retention ----------
-- Same as 20261114120039 (trips, destination searches, extractions), plus standalone city tours (trip_id null) 18
-- months after the later of input->>'date' (when it is a valid ISO date) and the last change, Berlin calendar day,
-- like trips [T18]. Linked tours are left alone: they lose the link when their trip is purged above, and the FK
-- update moves updated_at to now, so they are kept 18 more months from then. Signature, grants and cron schedule
-- unchanged; the return value stays the number of purged trips.
create or replace function private.purge_expired_trips()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  deleted integer;
  deleted_searches integer;
  deleted_extracts integer;
  deleted_tours integer;
begin
  delete from public.trips t
  using (select t2.id,
                greatest(t2.updated_at, p.updated_at,
                         (select max(i.updated_at) from public.trip_items i where i.trip_id = t2.id)) as last_update
           from public.trips t2
           left join public.plans p on p.trip_id = t2.id) x
  where x.id = t.id
    and private.trip_expires_on(x.last_update, t.start_date, t.length_days)
        < (now() at time zone 'Europe/Berlin')::date;
  get diagnostics deleted = row_count;
  if deleted > 0 then
    insert into public.app_events (event, props) values ('trips.purged', jsonb_build_object('count', deleted));
  end if;

  delete from public.destination_searches where updated_at < now() - interval '90 days';
  get diagnostics deleted_searches = row_count;
  if deleted_searches > 0 then
    insert into public.app_events (event, props)
      values ('destination_searches.purged', jsonb_build_object('count', deleted_searches));
  end if;

  delete from public.itinerary_extracts where created_at < now() - interval '30 days';
  get diagnostics deleted_extracts = row_count;
  if deleted_extracts > 0 then
    insert into public.app_events (event, props)
      values ('itinerary_extracts.purged', jsonb_build_object('count', deleted_extracts));
  end if;

  delete from public.city_tours c
   where c.trip_id is null
     and (greatest((c.updated_at at time zone 'Europe/Berlin')::date,
                   private.iso_date_or_null(c.input ->> 'date'))
          + interval '18 months')::date
         < (now() at time zone 'Europe/Berlin')::date;
  get diagnostics deleted_tours = row_count;
  if deleted_tours > 0 then
    insert into public.app_events (event, props)
      values ('city_tours.purged', jsonb_build_object('count', deleted_tours));
  end if;
  return deleted;
end;
$$;

revoke all on function private.purge_expired_trips() from public, anon, authenticated;
