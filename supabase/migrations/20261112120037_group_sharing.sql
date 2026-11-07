-- Share travel groups between users (docs/specs/group-sharing.md section 2, ADR 0011, issue #129).
-- Forward-only and additive, extends 20261110120035_sharing.sql. Safe to deploy alone (spec section 6): every new
-- policy depends on a group_shares row, and after this migration no group_shares row can be created by a client (no
-- insert or update privilege; public.share_resource is executable by service_role only, and the deployed server's
-- Zod enum rejects 'group'). The redefined shared_group_ids() adds an empty branch.
--
-- Deploy order: this migration first. Nobody may create group share rows by hand before the server PR is live.

-- ---------- 2.1 group_shares ----------
-- owner_id has no default: it is set by public.share_resource from its checked p_owner argument.
create table if not exists public.group_shares (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  group_id    uuid not null,
  grantee_id  uuid not null references auth.users (id) on delete cascade,
  access      text not null default 'read' check (access in ('read', 'write')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (group_id, owner_id) references public.travel_groups (id, owner_id) on delete cascade,
  constraint group_shares_not_self check (grantee_id <> owner_id),
  constraint group_shares_group_grantee_key unique (group_id, grantee_id)
);
create index if not exists group_shares_grantee_idx on public.group_shares (grantee_id, created_at desc);
create index if not exists group_shares_owner_idx on public.group_shares (owner_id);

drop trigger if exists group_shares_set_updated_at on public.group_shares;
create trigger group_shares_set_updated_at
  before update on public.group_shares
  for each row execute function private.set_updated_at();

alter table public.group_shares enable row level security;

-- No insert and no update grant: rows are created and their access changed only by public.share_resource (2.9).
revoke all on table public.group_shares from anon, authenticated, public;
grant select, delete on public.group_shares to authenticated;

drop policy if exists "group_shares: owner or grantee select" on public.group_shares;
create policy "group_shares: owner or grantee select" on public.group_shares
  for select to authenticated
  using ((select auth.uid()) = owner_id
         or ((select auth.uid()) = grantee_id and (select private.is_active(owner_id))));
drop policy if exists "group_shares: owner or grantee delete" on public.group_shares;
create policy "group_shares: owner or grantee delete" on public.group_shares
  for delete to authenticated
  using ((select auth.uid()) = owner_id or (select auth.uid()) = grantee_id);

-- ---------- 2.2 helper functions ----------
-- All security definer with an empty search_path (see 20261110120035 section 2.2).

-- REDEFINED (same signature): group shares to me, plus the groups of trips shared with me; both only while the GROUP
-- owner is active (the trip branch needs its own check now: a trip owner can use someone else's group). Also the set
-- of groups where "That's me" is allowed.
create or replace function private.shared_group_ids()
  returns uuid[]
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select array(
    select gs.group_id from public.group_shares gs
     where gs.grantee_id = (select auth.uid()) and private.is_active(gs.owner_id)
    union
    select t.group_id from public.trips t
      join public.travel_groups g on g.id = t.group_id
     where t.id = any (private.shared_trip_ids()) and private.is_active(g.owner_id)
  )
$$;

create or replace function private.writable_group_ids()
  returns uuid[]
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select array(
    select gs.group_id from public.group_shares gs
     where gs.grantee_id = (select auth.uid()) and gs.access = 'write' and private.is_active(gs.owner_id)
  )
$$;

-- p_group belongs to p_user, or is shared with p_user by an active owner (a group seen only through a shared trip does
-- not count).
create or replace function private.group_usable_by(p_group uuid, p_user uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (select 1 from public.travel_groups g where g.id = p_group and g.owner_id = p_user)
      or exists (
        select 1 from public.group_shares gs
         where gs.group_id = p_group and gs.grantee_id = p_user and private.is_active(gs.owner_id)
      )
$$;

-- Link pruning (2.8): does p_user still have ANY route to p_group? No is_active check: a disabled owner only hides,
-- the link comes back with the owner.
create or replace function private.group_reachable(p_group uuid, p_user uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
           select 1 from public.group_shares gs where gs.group_id = p_group and gs.grantee_id = p_user)
      or exists (
           select 1 from public.trip_shares s
             join public.trips t on t.id = s.trip_id
            where s.grantee_id = p_user and t.group_id = p_group)
$$;

revoke execute on function private.shared_group_ids() from public, anon;
revoke execute on function private.writable_group_ids() from public, anon;
grant execute on function private.shared_group_ids() to authenticated;
grant execute on function private.writable_group_ids() to authenticated;
-- Called only inside security definer functions and triggers: clients get no EXECUTE, so they cannot probe which ids
-- are usable groups or reachable links.
revoke execute on function private.group_usable_by(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.group_reachable(uuid, uuid) from public, anon, authenticated;

-- ---------- 2.3 policies added to existing tables (the owner policies and the grantee select policies stay) ----------
-- "travel_groups: grantee select" and "group_entries: grantee select" keep their text; they pick up the group-share
-- branch through the redefined shared_group_ids(). No delete policy on travel_groups for grantees.
drop policy if exists "travel_groups: write grantee update" on public.travel_groups;
create policy "travel_groups: write grantee update" on public.travel_groups
  for update to authenticated
  using (id = any ((select private.writable_group_ids())::uuid[]))
  with check (id = any ((select private.writable_group_ids())::uuid[]));

drop policy if exists "group_entries: write grantee insert" on public.group_entries;
create policy "group_entries: write grantee insert" on public.group_entries
  for insert to authenticated with check (group_id = any ((select private.writable_group_ids())::uuid[]));
drop policy if exists "group_entries: write grantee update" on public.group_entries;
create policy "group_entries: write grantee update" on public.group_entries
  for update to authenticated
  using (group_id = any ((select private.writable_group_ids())::uuid[]))
  with check (group_id = any ((select private.writable_group_ids())::uuid[]));
drop policy if exists "group_entries: write grantee delete" on public.group_entries;
create policy "group_entries: write grantee delete" on public.group_entries
  for delete to authenticated using (group_id = any ((select private.writable_group_ids())::uuid[]));

-- ---------- 2.4 owner of entries written by a grantee ----------
-- Same reasoning and failure modes as private.inherit_trip_owner: a stranger's insert gets the real owner's id and
-- fails the policy (42501); an unknown group leaves owner_id null and fails not null.
create or replace function private.inherit_group_owner()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  new.owner_id := (select g.owner_id from public.travel_groups g where g.id = new.group_id);
  return new;
end;
$$;
revoke all on function private.inherit_group_owner() from public, anon, authenticated;

drop trigger if exists group_entries_00_inherit_owner on public.group_entries;
create trigger group_entries_00_inherit_owner
  before insert on public.group_entries
  for each row execute function private.inherit_group_owner();

-- ---------- 2.6 links on group_entries (before 2.5: the guard reads the column) ----------
alter table public.group_entries
  add column if not exists linked_user_id uuid references auth.users (id) on delete set null;
alter table public.group_entries drop constraint if exists group_entries_link_shape;
alter table public.group_entries add constraint group_entries_link_shape
  check (linked_user_id is null or (kind = 'member' and not is_self));
alter table public.group_entries drop constraint if exists group_entries_link_not_owner;
alter table public.group_entries add constraint group_entries_link_not_owner
  check (linked_user_id is null or linked_user_id <> owner_id);
create unique index if not exists group_entries_one_link_idx on public.group_entries (group_id, linked_user_id)
  where linked_user_id is not null;
create index if not exists group_entries_linked_user_idx on public.group_entries (linked_user_id)
  where linked_user_id is not null;
-- linked_user_id is in neither the insert nor the update grant of group_entries, and replace_group_entries never
-- writes it (its column lists are explicit).

-- ---------- 2.5 entry guard: is_self and links ----------
-- Owner and grantee are both the `authenticated` role, so a trigger tells them apart. It acts only on user statements
-- (auth.uid() not null and current_user = 'authenticated'): the secret key, FK actions and the definer functions
-- (claim_group_entry, prune_group_links) pass untouched.
create or replace function private.group_entries_guard()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or current_user <> 'authenticated' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    if v_uid <> new.owner_id and new.is_self then
      raise exception 'owner_only' using errcode = '42501';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if v_uid <> old.owner_id and old.is_self then
      raise exception 'owner_only' using errcode = '42501';
    end if;
    if v_uid <> old.owner_id and old.linked_user_id is not null and old.linked_user_id <> v_uid then
      raise exception 'linked_entry' using errcode = '42501';
    end if;
    return old;
  end if;

  -- UPDATE
  if v_uid <> old.owner_id and new.is_self is distinct from old.is_self then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if old.linked_user_id is not null and (new.kind <> 'member' or new.is_self) then
    if v_uid in (old.owner_id, old.linked_user_id) then
      -- the owner or the linked user makes the entry ineligible: the link goes with it
      new.linked_user_id := null;
    else
      raise exception 'linked_entry' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.group_entries_guard() from public, anon, authenticated;

-- _01_ fires after _00_ (inherit owner) on insert; set_updated_at sorts after both.
drop trigger if exists group_entries_01_guard on public.group_entries;
create trigger group_entries_01_guard
  before insert or update or delete on public.group_entries
  for each row execute function private.group_entries_guard();

-- ---------- 2.6 claim and unclaim ----------
-- Errors: raise exception '<code>' using errcode = 'P0001'; the server maps the message. They take auth.uid() and
-- check everything themselves, and never change any column but linked_user_id (plus updated_at through the trigger).
create or replace function public.claim_group_entry(p_entry_id uuid)
  returns uuid
  language plpgsql
  security definer
  set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid     uuid := (select auth.uid());
  v_group   uuid;
  v_owner   uuid;
  v_kind    text;
  v_is_self boolean;
  v_linked  uuid;
  v_route   boolean;
begin
  if v_uid is null or p_entry_id is null then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  select e.group_id, e.owner_id into v_group, v_owner from public.group_entries e where e.id = p_entry_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  -- The owner is checked before visibility: an owner's own group is not in shared_group_ids(), and they already know
  -- the entry exists (spec 2.6 lists the checks in the other order, which would make "forbidden" unreachable).
  if v_owner = v_uid then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  -- A group the caller cannot see: the same answer as a missing row, no hint that the entry exists.
  if v_group <> all (private.shared_group_ids()) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  -- Claim vs. revoke race: a concurrent revoke (group share or trip share deleted, trip moved) prunes links in its own
  -- trigger, but does not see a claim that is not committed yet, so the claim would outlive its last route. Share-lock
  -- the route rows first: a revoke then waits for this transaction, and its prune trigger runs after our commit and
  -- sees the link. A revoke that committed before we got the lock leaves no row to lock: not_found. The locks are taken
  -- before the entry lock below, the same order as a revoke (route row, then the entries its prune touches), so the
  -- two cannot deadlock.
  perform 1 from public.group_shares gs
   where gs.group_id = v_group and gs.grantee_id = v_uid for share;
  v_route := found;
  perform 1 from public.trip_shares s join public.trips t on t.id = s.trip_id
   where s.grantee_id = v_uid and t.group_id = v_group for share of s, t;
  v_route := v_route or found;
  if not v_route then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  -- The row lock serializes two people claiming the same entry: the second one sees the link and gets already_linked.
  select e.kind, e.is_self, e.linked_user_id
    into v_kind, v_is_self, v_linked
    from public.group_entries e
   where e.id = p_entry_id
     for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_kind <> 'member' or v_is_self then
    raise exception 'not_eligible' using errcode = 'P0001';
  end if;
  if v_linked = v_uid then
    return v_group;
  end if;
  if v_linked is not null then
    raise exception 'already_linked' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.group_entries e where e.group_id = v_group and e.linked_user_id = v_uid) then
    raise exception 'already_claimed' using errcode = 'P0001';
  end if;

  begin
    update public.group_entries e set linked_user_id = v_uid where e.id = p_entry_id;
  exception when unique_violation then
    -- a parallel claim of another entry by the same user won the unique index group_entries_one_link_idx
    raise exception 'already_claimed' using errcode = 'P0001';
  end;

  -- their "about my age" may change: the plans of the claimer's own trips with this group turn outdated
  update public.trips t set updated_at = now() where t.owner_id = v_uid and t.group_id = v_group;
  return v_group;
end;
$$;
revoke all on function public.claim_group_entry(uuid) from public, anon;
grant execute on function public.claim_group_entry(uuid) to authenticated;

create or replace function public.unclaim_group_entry(p_entry_id uuid)
  returns table (group_id uuid, by_owner boolean)
  language plpgsql
  security definer
  set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid    uuid := (select auth.uid());
  v_group  uuid;
  v_owner  uuid;
  v_linked uuid;
begin
  if v_uid is null or p_entry_id is null then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  select e.group_id, e.owner_id, e.linked_user_id into v_group, v_owner, v_linked
    from public.group_entries e
   where e.id = p_entry_id
     for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  -- The linked user may always undo (also while the owner is disabled); the owner may remove. Anyone else needs to
  -- see the group to get a "forbidden" (or the harmless no-op for an unlinked entry); otherwise not_found.
  if v_linked is distinct from v_uid and v_owner <> v_uid then
    if v_group <> all (private.shared_group_ids()) then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
    if v_linked is not null then
      raise exception 'forbidden' using errcode = 'P0001';
    end if;
  end if;

  if v_linked is null then
    return query select v_group, v_owner = v_uid;
    return;
  end if;

  update public.group_entries e set linked_user_id = null where e.id = p_entry_id;
  update public.trips t set updated_at = now() where t.owner_id = v_linked and t.group_id = v_group;
  return query select v_group, v_owner = v_uid;
end;
$$;
revoke all on function public.unclaim_group_entry(uuid) from public, anon;
grant execute on function public.unclaim_group_entry(uuid) to authenticated;

-- ---------- 2.8 clearing links when the last route ends ----------
create or replace function private.prune_group_links(p_group uuid, p_user uuid)
  returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  update public.group_entries e set linked_user_id = null
   where e.linked_user_id is not null
     and (p_group is null or e.group_id = p_group)
     and (p_user is null or e.linked_user_id = p_user)
     and not private.group_reachable(e.group_id, e.linked_user_id);
end;
$$;
revoke all on function private.prune_group_links(uuid, uuid) from public, anon, authenticated;

-- trip share revoked or left, trip deleted (cascade), any trip owner
create or replace function private.trip_share_removed_prune()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  perform private.prune_group_links(null, old.grantee_id);
  return null;
end;
$$;
revoke all on function private.trip_share_removed_prune() from public, anon, authenticated;

drop trigger if exists trip_shares_prune_links on public.trip_shares;
create trigger trip_shares_prune_links
  after delete on public.trip_shares
  for each row execute function private.trip_share_removed_prune();

-- a trip's group_id changes or is cleared (by its owner, by group_share_removed, or by the FK when the group is deleted)
create or replace function private.trip_group_changed_prune()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  perform private.prune_group_links(old.group_id, null);
  return null;
end;
$$;
revoke all on function private.trip_group_changed_prune() from public, anon, authenticated;

drop trigger if exists trips_group_changed on public.trips;
create trigger trips_group_changed
  after update of group_id on public.trips
  for each row
  when (old.group_id is not null and old.group_id is distinct from new.group_id)
  execute function private.trip_group_changed_prune();

-- ---------- 2.7 group references on trips and destination_searches ----------
-- The composite same-owner FK (group_id, owner_id) becomes a plain FK plus a usable-by trigger. The default name is
-- <table>_group_id_owner_id_fkey; the DO block drops any foreign key to travel_groups with two columns whatever its
-- name, then the plain one is re-created idempotently.
do $$
declare
  r record;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname
      from pg_constraint c
     where c.conrelid in ('public.trips'::regclass, 'public.destination_searches'::regclass)
       and c.contype = 'f' and c.confrelid = 'public.travel_groups'::regclass and cardinality(c.conkey) = 2
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;
alter table public.trips drop constraint if exists trips_group_id_fkey;
alter table public.trips
  add constraint trips_group_id_fkey foreign key (group_id) references public.travel_groups (id) on delete set null;
alter table public.destination_searches drop constraint if exists destination_searches_group_id_fkey;
alter table public.destination_searches
  add constraint destination_searches_group_id_fkey
  foreign key (group_id) references public.travel_groups (id) on delete set null;
create index if not exists destination_searches_group_idx
  on public.destination_searches (group_id) where group_id is not null;

-- security definer: the check must also work for writes with the secret key (demo reset script). An unchanged group_id
-- on update is not re-checked, so a row whose group owner got disabled can still be edited. Fires after
-- trips_00_owner_only (name order), so a grantee changing group_id on someone else's trip still gets 42501.
create or replace function private.check_group_ref()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if new.group_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.group_id is not distinct from old.group_id then
    return new;
  end if;
  if not private.group_usable_by(new.group_id, new.owner_id) then
    raise exception 'group_not_usable' using errcode = '23503';
  end if;
  return new;
end;
$$;
revoke all on function private.check_group_ref() from public, anon, authenticated;

drop trigger if exists trips_check_group_ref on public.trips;
create trigger trips_check_group_ref
  before insert or update of group_id on public.trips
  for each row execute function private.check_group_ref();
drop trigger if exists destination_searches_check_group_ref on public.destination_searches;
create trigger destination_searches_check_group_ref
  before insert or update of group_id on public.destination_searches
  for each row execute function private.check_group_ref();

-- Unshare or leave a group: the grantee's own trips and searches lose the reference. The trips get a new updated_at
-- (their plans show as outdated; plan versions keep their snapshot). A search keeps its cards.
create or replace function private.group_share_removed()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  -- the group is gone (cascade from a group delete): the FK already cleared the references
  if not exists (select 1 from public.travel_groups g where g.id = old.group_id) then
    return null;
  end if;
  -- fires trips_group_changed, which prunes the links of the people those trips were shared with
  update public.trips set group_id = null
   where owner_id = old.grantee_id and group_id = old.group_id;
  update public.destination_searches set group_id = null
   where owner_id = old.grantee_id and group_id = old.group_id;
  perform private.prune_group_links(old.group_id, old.grantee_id);
  return null;
end;
$$;
revoke all on function private.group_share_removed() from public, anon, authenticated;

drop trigger if exists group_shares_removed on public.group_shares;
create trigger group_shares_removed
  after delete on public.group_shares
  for each row execute function private.group_share_removed();

-- ---------- 2.9 share_contacts, admin stats, share_resource (create or replace, same signatures) ----------
-- Both directions of group_shares, plus the users linked to entries of the caller's own groups. A transitive claimer
-- may be someone the owner never shared with: they come back with the display name and an empty email, never the email.
create or replace function public.share_contacts()
  returns table (user_id uuid, display_name text, email text)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  with c as (
    select s.grantee_id as uid from public.trip_shares s where s.owner_id = (select auth.uid())
    union
    select s.grantee_id from public.purpose_shares s where s.owner_id = (select auth.uid())
    union
    select s.grantee_id from public.group_shares s where s.owner_id = (select auth.uid())
    union
    select s.owner_id from public.trip_shares s
     where s.grantee_id = (select auth.uid()) and private.is_active(s.owner_id)
    union
    select s.owner_id from public.purpose_shares s
     where s.grantee_id = (select auth.uid()) and private.is_active(s.owner_id)
    union
    select s.owner_id from public.group_shares s
     where s.grantee_id = (select auth.uid()) and private.is_active(s.owner_id)
  ),
  l as (
    select distinct e.linked_user_id as uid from public.group_entries e
     where e.owner_id = (select auth.uid()) and e.linked_user_id is not null
  )
  select p.id, p.display_name, u.email::text
    from c
    join public.profiles p on p.id = c.uid
    join auth.users u on u.id = c.uid
  union all
  select p.id, p.display_name, ''::text
    from l
    join public.profiles p on p.id = l.uid
   where l.uid not in (select c2.uid from c c2)
$$;
revoke all on function public.share_contacts() from public, anon;
grant execute on function public.share_contacts() to authenticated;

create or replace function public.admin_share_stats(p_month_start timestamptz)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select jsonb_build_object(
    'tripSharesRead',        (select count(*) from public.trip_shares where access = 'read'),
    'tripSharesWrite',       (select count(*) from public.trip_shares where access = 'write'),
    'purposeSharesRead',     (select count(*) from public.purpose_shares where access = 'read'),
    'purposeSharesWrite',    (select count(*) from public.purpose_shares where access = 'write'),
    'groupSharesRead',       (select count(*) from public.group_shares where access = 'read'),
    'groupSharesWrite',      (select count(*) from public.group_shares where access = 'write'),
    'tripsShared',           (select count(distinct trip_id) from public.trip_shares),
    'groupsShared',          (select count(distinct group_id) from public.group_shares),
    'entryLinks',            (select count(*) from public.group_entries where linked_user_id is not null),
    'recipients',            (select count(distinct g) from (
                               select grantee_id as g from public.trip_shares
                               union all
                               select grantee_id from public.purpose_shares
                               union all
                               select grantee_id from public.group_shares) x),
    'grantsThisMonth',       (select count(*) from public.trip_shares where created_at >= p_month_start)
                             + (select count(*) from public.purpose_shares where created_at >= p_month_start)
                             + (select count(*) from public.group_shares where created_at >= p_month_start),
    'lookupsThisMonth',      (select count(*) from public.app_events
                               where event = 'sharing.lookup' and created_at >= p_month_start),
    'lookupMissesThisMonth', (select count(*) from public.app_events
                               where event = 'sharing.lookup' and created_at >= p_month_start
                                 and props ->> 'found' = 'false')
  )
$$;
revoke all on function public.admin_share_stats(timestamptz) from public, anon, authenticated;
grant execute on function public.admin_share_stats(timestamptz) to service_role;

-- Same as 20261110120035 section 2.9, plus p_resource = 'group'. MAX 10 grantees per resource.
create or replace function public.share_resource(
  p_owner uuid, p_resource text, p_resource_id uuid, p_grantee uuid, p_access text,
  p_share_id uuid default null)
  returns table (share_id uuid, created boolean)
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_existing uuid;
  v_new_id   uuid;
  v_count    integer;
begin
  -- 1. arguments
  if p_owner is null or p_resource is null or p_resource_id is null or p_grantee is null or p_access is null
     or p_resource not in ('trip', 'purpose', 'group') or p_access not in ('read', 'write') then
    raise exception 'invalid' using errcode = 'P0001';
  end if;

  -- 2. owner: has a profile, is not the demo account, is not disabled
  if not exists (select 1 from public.profiles p where p.id = p_owner and not p.is_demo)
     or not private.is_active(p_owner) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  -- 3. resource: owned by p_owner. The row lock serializes every concurrent call for this resource; for no key update
  -- does not block the key-share locks that item, plan, entry and share inserts take through their foreign keys.
  if p_resource = 'trip' then
    perform 1 from public.trips t where t.id = p_resource_id and t.owner_id = p_owner for no key update;
  elsif p_resource = 'purpose' then
    perform 1 from public.trip_purposes tp where tp.id = p_resource_id and tp.owner_id = p_owner for no key update;
  else
    perform 1 from public.travel_groups g where g.id = p_resource_id and g.owner_id = p_owner for no key update;
  end if;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  -- 4. grantee
  if p_grantee = p_owner then
    raise exception 'self_share' using errcode = 'P0001';
  end if;
  if not private.can_receive_share(p_grantee) then
    raise exception 'no_account' using errcode = 'P0001';
  end if;

  -- 5. existing grant: change the level (before the cap, so it works at 10 grantees). With p_share_id (update-only)
  -- the row must exist with this id, resource and grantee; steps 6 and 7 never run, so a stale access change cannot
  -- re-create a grant that was left or revoked meanwhile (a direct delete is not serialized by the lock of step 3).
  if p_resource = 'trip' then
    select s.id into v_existing from public.trip_shares s
     where s.trip_id = p_resource_id and s.grantee_id = p_grantee;
  elsif p_resource = 'purpose' then
    select s.id into v_existing from public.purpose_shares s
     where s.purpose_id = p_resource_id and s.grantee_id = p_grantee;
  else
    select s.id into v_existing from public.group_shares s
     where s.group_id = p_resource_id and s.grantee_id = p_grantee;
  end if;
  if p_share_id is not null and (v_existing is null or v_existing <> p_share_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_existing is not null then
    if p_resource = 'trip' then
      update public.trip_shares s set access = p_access where s.id = v_existing and s.access <> p_access;
    elsif p_resource = 'purpose' then
      update public.purpose_shares s set access = p_access where s.id = v_existing and s.access <> p_access;
    else
      update public.group_shares s set access = p_access where s.id = v_existing and s.access <> p_access;
    end if;
    return query select v_existing, false;
    return;
  end if;

  -- 6. cap, under the lock of step 3
  if p_resource = 'trip' then
    select count(*) into v_count from public.trip_shares s where s.trip_id = p_resource_id;
  elsif p_resource = 'purpose' then
    select count(*) into v_count from public.purpose_shares s where s.purpose_id = p_resource_id;
  else
    select count(*) into v_count from public.group_shares s where s.group_id = p_resource_id;
  end if;
  if v_count >= 10 then
    raise exception 'limit_reached' using errcode = 'P0001';
  end if;

  -- 7. insert
  if p_resource = 'trip' then
    insert into public.trip_shares (owner_id, trip_id, grantee_id, access)
      values (p_owner, p_resource_id, p_grantee, p_access) returning id into v_new_id;
  elsif p_resource = 'purpose' then
    insert into public.purpose_shares (owner_id, purpose_id, grantee_id, access)
      values (p_owner, p_resource_id, p_grantee, p_access) returning id into v_new_id;
  else
    insert into public.group_shares (owner_id, group_id, grantee_id, access)
      values (p_owner, p_resource_id, p_grantee, p_access) returning id into v_new_id;
  end if;
  return query select v_new_id, true;
end;
$$;
revoke all on function public.share_resource(uuid, text, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.share_resource(uuid, text, uuid, uuid, text, uuid) to service_role;

-- ---------- 2.10 optimistic check for group saves ----------
-- Same body as 20261101120024, plus a defaulted fourth argument: the first step locks the group row (a read grantee
-- gets no row, because for no key update needs the update policy) and compares updated_at. Old callers with three
-- named arguments resolve to this function through the default. Still security invoker: RLS and column grants apply.
drop function if exists public.replace_group_entries(uuid, jsonb, jsonb);
create or replace function public.replace_group_entries(
  p_group_id uuid, p_group jsonb, p_entries jsonb, p_expected_updated_at timestamptz default null)
  returns void
  language plpgsql
  security invoker
  set search_path = ''
as $$
declare
  v_updated_at timestamptz;
begin
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 30 then
    raise exception 'invalid_entries' using errcode = '22023';
  end if;

  select g.updated_at into v_updated_at from public.travel_groups g where g.id = p_group_id for no key update;
  if not found then
    raise exception 'group_not_found' using errcode = 'P0002';
  end if;
  if p_expected_updated_at is not null and v_updated_at <> p_expected_updated_at then
    raise exception 'conflict' using errcode = '40001';
  end if;

  update public.travel_groups
     set name = p_group ->> 'name', notes = p_group ->> 'notes',
         description = case when (p_group -> 'description') is not null then p_group ->> 'description' else description end,
         trait_keys = coalesce(array(select jsonb_array_elements_text(p_group -> 'trait_keys')), '{}')
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

revoke execute on function public.replace_group_entries(uuid, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.replace_group_entries(uuid, jsonb, jsonb, timestamptz) to authenticated;
