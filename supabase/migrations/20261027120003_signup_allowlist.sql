-- Invite-only signup: an email may create an account only if listed here.
-- Enforced by the Before User Created auth hook (enable it in the Dashboard, see
-- docs/specs/phase-1-dashboard-steps.md; locally it is enabled in supabase/config.toml).

create table if not exists public.signup_allowlist (
  id          bigint generated always as identity primary key,
  email       extensions.citext not null unique
    check (email::text = lower(email::text) and position('@' in email::text) > 1),
  note        text check (char_length(note) <= 200),
  invited_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.signup_allowlist enable row level security;

revoke all on public.signup_allowlist from anon, public;
grant select, insert, delete on public.signup_allowlist to authenticated;

drop policy if exists "signup_allowlist: admin select" on public.signup_allowlist;
create policy "signup_allowlist: admin select" on public.signup_allowlist
  for select to authenticated using ((select private.is_admin()));

drop policy if exists "signup_allowlist: admin insert" on public.signup_allowlist;
create policy "signup_allowlist: admin insert" on public.signup_allowlist
  for insert to authenticated with check ((select private.is_admin()));

drop policy if exists "signup_allowlist: admin delete" on public.signup_allowlist;
create policy "signup_allowlist: admin delete" on public.signup_allowlist
  for delete to authenticated using ((select private.is_admin()));
-- No update policy on purpose (delete + re-add).

-- Before User Created hook. Lives in `public` because the Dashboard hook picker lists
-- public functions; execute is restricted to supabase_auth_admin so it is not callable via the Data API.
create or replace function public.hook_before_user_created(event jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_email text := lower(event -> 'user' ->> 'email');
begin
  if v_email is not null
     and exists (select 1 from public.signup_allowlist where email::text = v_email) then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object('http_code', 403, 'message', 'signup_not_allowed')
  );
end;
$$;

revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
