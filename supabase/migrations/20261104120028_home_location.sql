-- Optional home location for the time difference shown on the trip page.
-- home_location = display name picked from the place search, home_timezone = its IANA zone.
-- Both null = default (Europe/Berlin, shown as Germany). The zone is validated in the app (Zod + Intl).
alter table public.profiles
  add column if not exists home_location text,
  add column if not exists home_timezone text;

alter table public.profiles
  drop constraint if exists profiles_home_location_len,
  drop constraint if exists profiles_home_timezone_len,
  drop constraint if exists profiles_home_pair;
alter table public.profiles
  add constraint profiles_home_location_len check (home_location is null or char_length(home_location) between 1 and 120),
  add constraint profiles_home_timezone_len check (home_timezone is null or char_length(home_timezone) between 1 and 64),
  add constraint profiles_home_pair check ((home_location is null) = (home_timezone is null));

-- Same pattern as the onboarding migration: revoke, then grant the user-updatable columns explicitly (idempotent).
-- All existing columns stay, the two new ones are added. role and is_demo stay out of the grant.
revoke update on public.profiles from authenticated;
grant update (display_name, locale, home_airports, birthdate, onboarding_done_at, home_location, home_timezone) on public.profiles to authenticated;
