-- trip_purposes. parsed_* (phase 3: Haiku tag cache) are written by the server with the secret key only.

-- Longest element of a text array (CHECK constraints cannot use subqueries). Pure, so IMMUTABLE.
create or replace function private.text_array_max_len(p_values text[])
  returns integer
  language sql
  immutable
  set search_path = ''
as $$
  select coalesce(max(char_length(v)), 0) from unnest(p_values) as v
$$;
revoke execute on function private.text_array_max_len(text[]) from public, anon;
grant execute on function private.text_array_max_len(text[]) to authenticated, service_role;

create table if not exists public.trip_purposes (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 80),
  text         text check (char_length("text") <= 4000),
  guided       jsonb not null default '{}'::jsonb
    check (jsonb_typeof(guided) = 'object' and pg_column_size(guided) < 8192),
  -- at most 30 constraints of at most 200 characters each
  constraints  text[] not null default '{}'
    check (cardinality(constraints) <= 30 and private.text_array_max_len(constraints) <= 200),
  parsed_tags  jsonb check (parsed_tags is null or pg_column_size(parsed_tags) < 16384),
  parsed_hash  text,
  parsed_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists trip_purposes_owner_idx on public.trip_purposes (owner_id, updated_at desc);

alter table public.trip_purposes enable row level security;

revoke all on table public.trip_purposes from anon, authenticated, public;
grant select, delete on public.trip_purposes to authenticated;
-- Column grants: the browser/user session cannot write parsed_*. owner_id comes from its default (auth.uid()).
grant insert (name, text, guided, constraints) on public.trip_purposes to authenticated;
grant update (name, text, guided, constraints) on public.trip_purposes to authenticated;

drop policy if exists "trip_purposes: owner select" on public.trip_purposes;
create policy "trip_purposes: owner select" on public.trip_purposes
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists "trip_purposes: owner insert" on public.trip_purposes;
create policy "trip_purposes: owner insert" on public.trip_purposes
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists "trip_purposes: owner update" on public.trip_purposes;
create policy "trip_purposes: owner update" on public.trip_purposes
  for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "trip_purposes: owner delete" on public.trip_purposes;
create policy "trip_purposes: owner delete" on public.trip_purposes
  for delete to authenticated using ((select auth.uid()) = owner_id);

drop trigger if exists trip_purposes_set_updated_at on public.trip_purposes;
create trigger trip_purposes_set_updated_at
  before update on public.trip_purposes
  for each row execute function private.set_updated_at();
