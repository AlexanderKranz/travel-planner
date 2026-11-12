-- Trip stops and the extraction cache (docs/specs/itinerary-upload.md section 2 [D4] [D10]; port-places adds no
-- migration). Forward-only and additive: the old app selects explicit columns and never writes stops.

-- ---------- trips.stops: CONFIRMED stops only ----------
-- A jsonb array of TripStop (src/lib/domain/trip-stops.ts), saved by the user through the trip form. Stops derived
-- from the notes are never written here ([D10]). The shape is validated by Zod in the app; the database only bounds
-- the size, because clients hold the column grant.
alter table public.trips
  add column if not exists stops jsonb check (
    stops is null
    or (jsonb_typeof(stops) = 'array' and jsonb_array_length(stops) <= 40 and pg_column_size(stops) < 16384));

-- User-writable. NOT in private.trips_owner_only(): write grantees may edit stops like notes (sharing [D3] lists only
-- group and purpose as owner-only). The trips owner and write-grantee policies already cover the column; read
-- grantees cannot update at all.
grant insert (stops) on public.trips to authenticated;
grant update (stops) on public.trips to authenticated;

-- ---------- itinerary_extracts: cache of AI extractions ----------
-- One row per (owner, payload hash): the normalized result of the Haiku itinerary_extract task, for uploads and for
-- stops derived from the trip notes. For a notes derivation the row belongs to the TRIP OWNER (the data is about the
-- owner's trip); the AI cost goes to the acting user. Never shared across users. api_cache is not used: it is global
-- and meant for public facts.
create table if not exists public.itinerary_extracts (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  -- sha256 of prompt version + model + the exact payload sent to the model.
  hash       text not null check (hash ~ '^[0-9a-f]{64}$'),
  -- Normalized extraction (same bounds as trips.stops).
  stops      jsonb not null check (
    jsonb_typeof(stops) = 'array' and jsonb_array_length(stops) <= 40 and pg_column_size(stops) < 16384),
  -- Per-stop flags of the normalization (not_in_source, time_unclear, ...). Counts and codes, no content.
  flags      jsonb not null default '[]' check (
    jsonb_typeof(flags) in ('array', 'object') and pg_column_size(flags) < 8192),
  created_at timestamptz not null default now(),
  constraint itinerary_extracts_owner_hash_key unique (owner_id, hash)
);

alter table public.itinerary_extracts enable row level security;
revoke all on table public.itinerary_extracts from anon, authenticated, public;
-- Owner select and delete only. NO insert or update grant: the server writes with the secret key, filtered by
-- owner_id (like saveGroupParse), so nobody can plant extractions that look machine-made.
grant select, delete on public.itinerary_extracts to authenticated;
grant select, insert, update, delete on public.itinerary_extracts to service_role;

drop policy if exists "itinerary_extracts: owner select" on public.itinerary_extracts;
create policy "itinerary_extracts: owner select" on public.itinerary_extracts
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists "itinerary_extracts: owner delete" on public.itinerary_extracts;
create policy "itinerary_extracts: owner delete" on public.itinerary_extracts
  for delete to authenticated using ((select auth.uid()) = owner_id);

-- ---------- ai_usage: task for the Haiku itinerary extraction ----------
alter table public.ai_usage drop constraint if exists ai_usage_task_check;
alter table public.ai_usage add constraint ai_usage_task_check
  check (task in ('purpose_tags', 'group_parse', 'destination_ideas', 'itinerary_extract', 'plan_generate', 'plan_patch'));

-- ---------- retention ----------
-- Same as 20261106120031 (trips, destination searches), plus extractions older than 30 days. Signature, grants and
-- cron schedule unchanged.
create or replace function private.purge_expired_trips()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  deleted integer;
  deleted_searches integer;
  deleted_extracts integer;
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
  return deleted;
end;
$$;

revoke all on function private.purge_expired_trips() from public, anon, authenticated;
