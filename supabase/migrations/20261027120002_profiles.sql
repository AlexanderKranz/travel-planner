-- profiles: one row per auth user, created by trigger (see handle_new_user migration).
-- The PK is the user id, so the RLS column is `id`.

create table if not exists public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  role           text not null default 'user' check (role in ('user', 'admin')),
  display_name   text check (char_length(display_name) <= 80),
  locale         text not null default 'de' check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  home_airports  text[] not null default '{}'
    check (
      cardinality(home_airports) <= 5
      and array_to_string(home_airports, ',') ~ '^([A-Z]{3}(,[A-Z]{3})*)?$'
    ),
  birthdate      date check (birthdate >= date '1900-01-01'),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.profiles enable row level security;

revoke all on public.profiles from anon, public;
grant select on public.profiles to authenticated;
-- Column-level grant: users can NOT change `role` (no self-promotion to admin).
grant update (display_name, locale, home_airports, birthdate) on public.profiles to authenticated;

drop policy if exists "profiles: self select" on public.profiles;
create policy "profiles: self select" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "profiles: self update" on public.profiles;
create policy "profiles: self update" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
-- No insert policy (trigger creates rows), no delete policy (delete the auth user -> cascade).

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- security definer so policies on other tables can check the role without
-- being blocked by profiles RLS. Fixed search_path; returns false for anon (auth.uid() is null).
create or replace function private.is_admin()
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'
  )
$$;

revoke execute on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;
