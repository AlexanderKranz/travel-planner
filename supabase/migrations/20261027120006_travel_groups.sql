-- travel_groups + group_entries. All context is optional: a group may be just a name.

create table if not exists public.travel_groups (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  notes       text check (char_length(notes) <= 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, owner_id)  -- target of the composite FK from group_entries
);

create index if not exists travel_groups_owner_idx on public.travel_groups (owner_id, updated_at desc);

create table if not exists public.group_entries (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null,
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('composition', 'member')),
  "position"  smallint not null default 0,
  count       smallint not null default 1 check (count between 1 and 50),
  label       text check (char_length(label) <= 60),
  name        text check (char_length(name) <= 80),
  is_self     boolean not null default false,
  birthdate   date check (birthdate >= date '1900-01-01'),
  age_mode    text check (age_mode in ('exact', 'approx', 'relativeToMe')),
  age         smallint check (age between 0 and 120),
  age_as_of   date,
  notes       text check (char_length(notes) <= 1000),
  traits      jsonb not null default '{}'::jsonb check (jsonb_typeof(traits) = 'object'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- An entry always belongs to a group of the same owner, so plain owner policies suffice.
  foreign key (group_id, owner_id)
    references public.travel_groups (id, owner_id) on delete cascade,

  -- kind rules
  constraint group_entries_composition_shape
    check (kind = 'member' or (name is null and birthdate is null and not is_self)),
  constraint group_entries_member_single
    check (kind = 'composition' or count = 1),
  constraint group_entries_member_identity
    check (kind = 'composition' or is_self or name is not null),
  constraint group_entries_self_shape
    check (not is_self or (name is null and birthdate is null and age_mode is null)),

  -- age rules (ages are never stored for people with a birthdate)
  constraint group_entries_birthdate_xor_age
    check (birthdate is null or age_mode is null),
  constraint group_entries_age_requires_mode
    check (age_mode is not null or (age is null and age_as_of is null)),
  constraint group_entries_stated_age_complete
    check (age_mode is null or age_mode not in ('exact', 'approx') or (age is not null and age_as_of is not null)),
  constraint group_entries_relative_no_age
    check (age_mode is null or age_mode <> 'relativeToMe' or (age is null and age_as_of is null))
);

create index if not exists group_entries_group_idx on public.group_entries (group_id, "position");
create unique index if not exists group_entries_one_self_idx on public.group_entries (group_id) where is_self;

-- RLS: standard owner policies
alter table public.travel_groups enable row level security;
revoke all on public.travel_groups from anon, public;
grant select, insert, update, delete on public.travel_groups to authenticated;

drop policy if exists "travel_groups: owner select" on public.travel_groups;
create policy "travel_groups: owner select" on public.travel_groups
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists "travel_groups: owner insert" on public.travel_groups;
create policy "travel_groups: owner insert" on public.travel_groups
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists "travel_groups: owner update" on public.travel_groups;
create policy "travel_groups: owner update" on public.travel_groups
  for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "travel_groups: owner delete" on public.travel_groups;
create policy "travel_groups: owner delete" on public.travel_groups
  for delete to authenticated using ((select auth.uid()) = owner_id);

alter table public.group_entries enable row level security;
revoke all on public.group_entries from anon, public;
grant select, insert, update, delete on public.group_entries to authenticated;

drop policy if exists "group_entries: owner select" on public.group_entries;
create policy "group_entries: owner select" on public.group_entries
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists "group_entries: owner insert" on public.group_entries;
create policy "group_entries: owner insert" on public.group_entries
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists "group_entries: owner update" on public.group_entries;
create policy "group_entries: owner update" on public.group_entries
  for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "group_entries: owner delete" on public.group_entries;
create policy "group_entries: owner delete" on public.group_entries
  for delete to authenticated using ((select auth.uid()) = owner_id);

drop trigger if exists travel_groups_set_updated_at on public.travel_groups;
create trigger travel_groups_set_updated_at
  before update on public.travel_groups
  for each row execute function private.set_updated_at();

drop trigger if exists group_entries_set_updated_at on public.group_entries;
create trigger group_entries_set_updated_at
  before update on public.group_entries
  for each row execute function private.set_updated_at();
