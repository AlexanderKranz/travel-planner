-- Phase 1 base: private schema (not exposed by the Data API), citext, updated_at trigger function.
-- Functions in `private` are helpers only; never grant `private` usage to anon.

create schema if not exists private;
-- supabase_auth_admin runs the auth.users signup trigger (see handle_new_user migration).
grant usage on schema private to authenticated, supabase_auth_admin;

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
