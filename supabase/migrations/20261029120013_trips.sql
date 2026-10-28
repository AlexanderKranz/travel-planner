-- trips: destination inline, timing = exact date OR months OR nothing, nullable same-owner group/purpose.
-- Requires PostgreSQL >= 15 (ON DELETE SET NULL (column list)).
-- Per-user cap (30 trips) is a business rule enforced in the server action, not here.

-- Target of the composite FK (travel_groups already has unique (id, owner_id)).
alter table public.trip_purposes
  add constraint trip_purposes_id_owner_key unique (id, owner_id);

create table if not exists public.trips (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title              text check (char_length(title) between 1 and 120),
  dest_kind          text not null check (dest_kind in ('city', 'region', 'freetext')),
  dest_name          text not null check (char_length(dest_name) between 1 and 120),
  dest_place_name    text check (char_length(dest_place_name) <= 120),
  dest_geo_id        bigint,
  dest_country_code  text check (dest_country_code ~ '^[A-Z]{2}$'),
  dest_admin1        text check (char_length(dest_admin1) <= 120),
  dest_lat           double precision check (dest_lat between -90 and 90),
  dest_lon           double precision check (dest_lon between -180 and 180),
  dest_timezone      text check (char_length(dest_timezone) <= 64),
  dest_radius_km     smallint check (dest_radius_km between 1 and 200),
  length_days        smallint not null check (length_days between 1 and 60),
  start_date         date check (start_date between '2000-01-01' and '2100-12-31'),
  months             smallint[] not null default '{}'
    check (cardinality(months) <= 12 and months <@ array[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[]),
  group_id           uuid,
  purpose_id         uuid,
  wants_flights      boolean not null default true,
  origin_airports    text[] not null default '{}'
    check (cardinality(origin_airports) <= 5 and array_to_string(origin_airports, ',') ~ '^([A-Z]{3}(,[A-Z]{3})*)?$'),
  notes              text check (char_length(notes) <= 2000),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- same-owner references; deleting a group/purpose clears only the reference column (PG >= 15)
  foreign key (group_id, owner_id)   references public.travel_groups (id, owner_id) on delete set null (group_id),
  foreign key (purpose_id, owner_id) references public.trip_purposes (id, owner_id) on delete set null (purpose_id),

  -- destination shape
  constraint trips_dest_geo check (
    (dest_kind = 'freetext'
       and dest_lat is null and dest_lon is null and dest_geo_id is null and dest_place_name is null
       and dest_admin1 is null and dest_timezone is null and dest_radius_km is null)
    or
    (dest_kind in ('city', 'region')
       and dest_lat is not null and dest_lon is not null and dest_geo_id is not null and dest_place_name is not null)
  ),
  -- timing: exact date OR months OR nothing
  constraint trips_timing_exclusive check (start_date is null or cardinality(months) = 0)
);

create index if not exists trips_owner_idx on public.trips (owner_id, updated_at desc);
create index if not exists trips_group_idx on public.trips (group_id) where group_id is not null;
create index if not exists trips_purpose_idx on public.trips (purpose_id) where purpose_id is not null;

alter table public.trips enable row level security;

revoke all on table public.trips from anon, authenticated, public;
grant select, delete on public.trips to authenticated;
-- Column grants: id and owner_id can never be written by a user session (owner_id comes from its default).
grant insert (title, dest_kind, dest_name, dest_place_name, dest_geo_id, dest_country_code, dest_admin1,
              dest_lat, dest_lon, dest_timezone, dest_radius_km, length_days, start_date, months,
              group_id, purpose_id, wants_flights, origin_airports, notes) on public.trips to authenticated;
grant update (title, dest_kind, dest_name, dest_place_name, dest_geo_id, dest_country_code, dest_admin1,
              dest_lat, dest_lon, dest_timezone, dest_radius_km, length_days, start_date, months,
              group_id, purpose_id, wants_flights, origin_airports, notes) on public.trips to authenticated;

drop policy if exists "trips: owner select" on public.trips;
create policy "trips: owner select" on public.trips
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists "trips: owner insert" on public.trips;
create policy "trips: owner insert" on public.trips
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists "trips: owner update" on public.trips;
create policy "trips: owner update" on public.trips
  for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "trips: owner delete" on public.trips;
create policy "trips: owner delete" on public.trips
  for delete to authenticated using ((select auth.uid()) = owner_id);

drop trigger if exists trips_set_updated_at on public.trips;
create trigger trips_set_updated_at
  before update on public.trips
  for each row execute function private.set_updated_at();
