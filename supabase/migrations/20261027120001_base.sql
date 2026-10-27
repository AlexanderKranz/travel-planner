-- Phase 1 base: private schema (not exposed by the Data API), citext, updated_at trigger function.
-- Functions in `private` are helpers only; never grant `private` usage to anon.

create schema if not exists private;
-- supabase_auth_admin runs the auth.users signup trigger (see handle_new_user migration).
grant usage on schema private to authenticated, supabase_auth_admin, service_role;

-- Privilege hardening (B1). Supabase grants ALL on new public tables/functions/sequences to
-- anon and authenticated by default, which would make column-level grants meaningless
-- (a table-level grant covers every column). Switch to deny-by-default: every migration
-- must grant exactly what the app needs. service_role (secret key) keeps its defaults.
-- Applies to objects created by the role running migrations (postgres).
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
-- Objects that already exist (none in a fresh project) are covered by the explicit revokes in each migration.

create extension if not exists citext with schema extensions;

create or replace function private.set_updated_at()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
