-- Find destinations by driving time (docs/specs/find-destinations-drive.md section 8, ADR 0007).
-- Additive only: the running app keeps working with the extra columns. Existing searches become 'flight'.

-- ---------- profiles: home coordinates ----------
-- Resolved by the server from the place id (never supplied by the browser), used for drive-time lookups only.
alter table public.profiles
  add column if not exists home_geo_id integer,
  add column if not exists home_lat    double precision,
  add column if not exists home_lon    double precision;

alter table public.profiles
  drop constraint if exists profiles_home_lat_range,
  drop constraint if exists profiles_home_lon_range,
  drop constraint if exists profiles_home_coords;
alter table public.profiles
  add constraint profiles_home_lat_range check (home_lat is null or home_lat between -90 and 90),
  add constraint profiles_home_lon_range check (home_lon is null or home_lon between -180 and 180),
  -- all three or none, and only together with a home name
  add constraint profiles_home_coords check (
    ((home_geo_id is null) = (home_lat is null))
    and ((home_lat is null) = (home_lon is null))
    and (home_geo_id is null or home_location is not null)
  );

grant update (display_name, locale, home_airports, birthdate, onboarding_done_at, home_location, home_timezone,
              home_geo_id, home_lat, home_lon)
  on public.profiles to authenticated;

-- ---------- destination_searches: travel mode ----------
alter table public.destination_searches
  add column if not exists travel_mode     text not null default 'flight',
  add column if not exists max_drive_hours numeric(3, 1),
  add column if not exists home_name       text,
  add column if not exists home_lat        double precision,
  add column if not exists home_lon        double precision;

alter table public.destination_searches
  drop constraint if exists destination_searches_travel_mode_check,
  drop constraint if exists destination_searches_max_drive_hours_check,
  drop constraint if exists destination_searches_home_name_check,
  drop constraint if exists destination_searches_home_lat_check,
  drop constraint if exists destination_searches_home_lon_check,
  drop constraint if exists destination_searches_mode_shape;
alter table public.destination_searches
  add constraint destination_searches_travel_mode_check check (travel_mode in ('flight', 'drive')),
  add constraint destination_searches_max_drive_hours_check check (max_drive_hours is null or max_drive_hours between 1 and 12),
  add constraint destination_searches_home_name_check check (home_name is null or char_length(home_name) between 1 and 120),
  add constraint destination_searches_home_lat_check check (home_lat is null or home_lat between -90 and 90),
  add constraint destination_searches_home_lon_check check (home_lon is null or home_lon between -180 and 180),
  -- flight: no drive columns. drive: all four set, no airports, no flight limit.
  add constraint destination_searches_mode_shape check (
    (travel_mode = 'flight'
      and max_drive_hours is null and home_name is null and home_lat is null and home_lon is null)
    or
    (travel_mode = 'drive'
      and max_drive_hours is not null and home_name is not null and home_lat is not null and home_lon is not null
      and cardinality(origins) = 0 and max_flight_hours is null)
  );

-- claimRound1 updates a reused row, so the new columns need the update grant as well as the insert grant.
-- id, owner_id (default auth.uid()) and created_at stay unwritable for user sessions.
grant insert (purpose_id, group_id, purpose_name, locale, months, origins, max_flight_hours, radius_km, input_hash,
              input, status, busy_until, rounds, cards, drops, error_code, model, cost_micro_usd,
              travel_mode, max_drive_hours, home_name, home_lat, home_lon)
  on public.destination_searches to authenticated;
grant update (purpose_id, group_id, purpose_name, locale, months, origins, max_flight_hours, radius_km,
              input, status, busy_until, rounds, cards, drops, error_code, model, cost_micro_usd,
              travel_mode, max_drive_hours, home_name, home_lat, home_lon)
  on public.destination_searches to authenticated;
