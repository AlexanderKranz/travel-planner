-- Getting-started guide: when the user finished or skipped it (null = not yet, shown once after the first login).
-- Not in any other table: it is a per-user flag like the other profile settings.

alter table public.profiles
  add column if not exists onboarding_done_at timestamptz;

-- Existing users must not be sent to the guide after the deploy: mark every profile that exists now as done.
-- (The guide stays reachable from Einstellungen.) Only profiles created afterwards start with null.
update public.profiles set onboarding_done_at = now() where onboarding_done_at is null;

-- Same pattern as the demo migration: revoke, then grant the user-updatable columns explicitly (idempotent).
-- role and is_demo stay out of the grant. RLS policies are unchanged (self select / self update).
revoke update on public.profiles from authenticated;
grant update (display_name, locale, home_airports, birthdate, onboarding_done_at) on public.profiles to authenticated;
