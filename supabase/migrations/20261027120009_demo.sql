-- Shared demo account (one user, set up by scripts/demo/reset.mjs with the secret key).
-- is_demo is NOT in the user-updatable column grants: only the server (secret key) can set it.
-- The demo user can never be admin, even if someone updates role as postgres/service_role.

alter table public.profiles
  add column if not exists is_demo boolean not null default false;

alter table public.profiles drop constraint if exists profiles_demo_never_admin;
alter table public.profiles
  add constraint profiles_demo_never_admin check (not (is_demo and role = 'admin'));

-- Re-assert the grants explicitly (idempotent): users may update these columns only.
revoke update on public.profiles from authenticated;
grant update (display_name, locale, home_airports, birthdate) on public.profiles to authenticated;
