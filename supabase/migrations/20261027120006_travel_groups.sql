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
  traits      jsonb not null default '{}'::jsonb
    check (jsonb_typeof(traits) = 'object' and pg_column_size(traits) < 8192),
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
revoke all on table public.travel_groups from anon, authenticated, public;
grant select, delete on public.travel_groups to authenticated;
-- owner_id/id come from defaults; owner_id can never be changed by the user.
grant insert (name, notes) on public.travel_groups to authenticated;
grant update (name, notes) on public.travel_groups to authenticated;

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
revoke all on table public.group_entries from anon, authenticated, public;
grant select, delete on public.group_entries to authenticated;
-- id and owner_id come from defaults; group_id is fixed after insert (no moving entries between groups).
grant insert (group_id, kind, "position", count, label, name, is_self, birthdate,
              age_mode, age, age_as_of, notes, traits) on public.group_entries to authenticated;
grant update (kind, "position", count, label, name, is_self, birthdate,
              age_mode, age, age_as_of, notes, traits) on public.group_entries to authenticated;

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

-- Atomic group update (S3). PostgREST runs one request per statement, so a multi-step update
-- from the app could leave a half-written group. This function does it in ONE transaction.
-- SECURITY INVOKER: runs with the caller's rights, so RLS and the column grants above still apply.
--
-- p_group:   {"name": text, "notes": text|null}
-- p_entries: array of entry objects with the group_entries column names (snake_case); `id` present
--            = update that entry of this group, absent = insert, entries of the group not listed = deleted.
--            Array order is NOT used; send `position` explicitly.
-- Raises: P0002 (group not found / not visible), 22023 (invalid entry list).
create or replace function public.replace_group_entries(p_group_id uuid, p_group jsonb, p_entries jsonb)
  returns void
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 30 then
    raise exception 'invalid_entries' using errcode = '22023';
  end if;

  update public.travel_groups
     set name = p_group ->> 'name', notes = p_group ->> 'notes'
   where id = p_group_id;
  if not found then
    raise exception 'group_not_found' using errcode = 'P0002';
  end if;

  -- Every given id must be an entry of this group and appear once.
  if exists (
       select 1 from jsonb_populate_recordset(null::public.group_entries, p_entries) r
        where r.id is not null
          and not exists (select 1 from public.group_entries e where e.id = r.id and e.group_id = p_group_id)
     )
     or exists (
       select 1 from jsonb_populate_recordset(null::public.group_entries, p_entries) r where r.id is not null group by r.id having count(*) > 1
     ) then
    raise exception 'invalid_entries' using errcode = '22023';
  end if;

  -- Delete first so a replaced "self" entry cannot collide with the unique index.
  delete from public.group_entries e
   where e.group_id = p_group_id
     and e.id not in (select r.id from jsonb_populate_recordset(null::public.group_entries, p_entries) r where r.id is not null);

  -- Updates in two passes (non-self first) so moving the "self" flag between entries does not
  -- trip the one-self-per-group unique index.
  update public.group_entries e
     set kind = r.kind, "position" = r."position", count = r.count, label = r.label, name = r.name,
         is_self = r.is_self, birthdate = r.birthdate, age_mode = r.age_mode, age = r.age,
         age_as_of = r.age_as_of, notes = r.notes, traits = r.traits
    from jsonb_populate_recordset(null::public.group_entries, p_entries) r
   where e.id = r.id and e.group_id = p_group_id and not r.is_self;
  update public.group_entries e
     set kind = r.kind, "position" = r."position", count = r.count, label = r.label, name = r.name,
         is_self = r.is_self, birthdate = r.birthdate, age_mode = r.age_mode, age = r.age,
         age_as_of = r.age_as_of, notes = r.notes, traits = r.traits
    from jsonb_populate_recordset(null::public.group_entries, p_entries) r
   where e.id = r.id and e.group_id = p_group_id and r.is_self;

  insert into public.group_entries
    (group_id, kind, "position", count, label, name, is_self, birthdate, age_mode, age, age_as_of, notes, traits)
  select p_group_id, r.kind, r."position", r.count, r.label, r.name, r.is_self, r.birthdate,
         r.age_mode, r.age, r.age_as_of, r.notes, r.traits
    from jsonb_populate_recordset(null::public.group_entries, p_entries) r
   where r.id is null;
end;
$$;

revoke execute on function public.replace_group_entries(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_group_entries(uuid, jsonb, jsonb) to authenticated;

-- Atomic reorder: `p_ids` must be exactly the ids of the group's entries; position = array index.
-- SECURITY INVOKER (RLS applies). Raises 22023 on a mismatch.
create or replace function public.reorder_group_entries(p_group_id uuid, p_ids uuid[])
  returns void
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  if (select count(*) from public.group_entries where group_id = p_group_id) <> coalesce(cardinality(p_ids), 0)
     or (select count(distinct i) from unnest(p_ids) i) <> coalesce(cardinality(p_ids), 0)
     or exists (
       select 1 from unnest(p_ids) i
        where not exists (select 1 from public.group_entries e where e.id = i and e.group_id = p_group_id)
     ) then
    raise exception 'invalid_entries' using errcode = '22023';
  end if;

  update public.group_entries e
     set "position" = (u.ord - 1)::smallint
    from unnest(p_ids) with ordinality as u(id, ord)
   where e.id = u.id and e.group_id = p_group_id;
end;
$$;

revoke execute on function public.reorder_group_entries(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.reorder_group_entries(uuid, uuid[]) to authenticated;
