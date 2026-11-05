-- Share trips and trip purposes between users (docs/specs/sharing.md section 2, ADR 0010, issue #82).
-- Forward-only and additive. Safe to deploy alone (spec section 6): every new policy and helper depends on a share row,
-- and after this migration no share row can be created by a client (no insert or update privilege on the share
-- tables; public.share_resource is executable by service_role only, which the current app never calls).
--
-- Deploy order: this migration first. Nobody may create share rows by hand before the server PR is live.

-- ---------- 2.1 trip_shares and purpose_shares ----------
-- owner_id has no default: it is set by public.share_resource from its checked p_owner argument.
create table if not exists public.trip_shares (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  trip_id     uuid not null,
  grantee_id  uuid not null references auth.users (id) on delete cascade,
  access      text not null default 'read' check (access in ('read', 'write')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (trip_id, owner_id) references public.trips (id, owner_id) on delete cascade,
  constraint trip_shares_not_self check (grantee_id <> owner_id),
  constraint trip_shares_trip_grantee_key unique (trip_id, grantee_id)
);
create index if not exists trip_shares_grantee_idx on public.trip_shares (grantee_id, created_at desc);
create index if not exists trip_shares_owner_idx on public.trip_shares (owner_id);

create table if not exists public.purpose_shares (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  purpose_id  uuid not null,
  grantee_id  uuid not null references auth.users (id) on delete cascade,
  access      text not null default 'read' check (access in ('read', 'write')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (purpose_id, owner_id) references public.trip_purposes (id, owner_id) on delete cascade,
  constraint purpose_shares_not_self check (grantee_id <> owner_id),
  constraint purpose_shares_purpose_grantee_key unique (purpose_id, grantee_id)
);
create index if not exists purpose_shares_grantee_idx on public.purpose_shares (grantee_id, created_at desc);
create index if not exists purpose_shares_owner_idx on public.purpose_shares (owner_id);

drop trigger if exists trip_shares_set_updated_at on public.trip_shares;
create trigger trip_shares_set_updated_at
  before update on public.trip_shares
  for each row execute function private.set_updated_at();
drop trigger if exists purpose_shares_set_updated_at on public.purpose_shares;
create trigger purpose_shares_set_updated_at
  before update on public.purpose_shares
  for each row execute function private.set_updated_at();

alter table public.trip_shares enable row level security;
alter table public.purpose_shares enable row level security;

-- No insert and no update grant: rows are created and their access changed only by public.share_resource (2.9).
revoke all on table public.trip_shares from anon, authenticated, public;
revoke all on table public.purpose_shares from anon, authenticated, public;
grant select, delete on public.trip_shares to authenticated;
grant select, delete on public.purpose_shares to authenticated;

-- ---------- 2.2 helper functions ----------
-- All security definer with an empty search_path, so the policies below read the share tables without recursion.
-- A disabled owner is hidden on every recipient path through private.is_active().

create or replace function private.is_active(p_user uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (select 1 from public.profiles p where p.id = p_user and p.disabled_at is null)
$$;

create or replace function private.shared_trip_ids()
  returns uuid[]
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select array(
    select s.trip_id from public.trip_shares s
     where s.grantee_id = (select auth.uid()) and private.is_active(s.owner_id)
  )
$$;

create or replace function private.writable_trip_ids()
  returns uuid[]
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select array(
    select s.trip_id from public.trip_shares s
     where s.grantee_id = (select auth.uid()) and s.access = 'write' and private.is_active(s.owner_id)
  )
$$;

create or replace function private.shared_plan_ids()
  returns uuid[]
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select array(select p.id from public.plans p where p.trip_id = any (private.shared_trip_ids()))
$$;

create or replace function private.writable_plan_ids()
  returns uuid[]
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select array(select p.id from public.plans p where p.trip_id = any (private.writable_trip_ids()))
$$;

create or replace function private.shared_group_ids()
  returns uuid[]
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select array(
    select t.group_id from public.trips t
     where t.id = any (private.shared_trip_ids()) and t.group_id is not null
  )
$$;

-- Purposes shared with me, plus the purposes of trips shared with me (both only while the purpose owner is active).
create or replace function private.shared_purpose_ids()
  returns uuid[]
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select array(
    select ps.purpose_id from public.purpose_shares ps
     where ps.grantee_id = (select auth.uid()) and private.is_active(ps.owner_id)
    union
    select t.purpose_id from public.trips t
      join public.trip_purposes p on p.id = t.purpose_id
     where t.id = any (private.shared_trip_ids()) and private.is_active(p.owner_id)
  )
$$;

create or replace function private.writable_purpose_ids()
  returns uuid[]
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select array(
    select ps.purpose_id from public.purpose_shares ps
     where ps.grantee_id = (select auth.uid()) and ps.access = 'write' and private.is_active(ps.owner_id)
  )
$$;

create or replace function private.can_receive_share(p_user uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p where p.id = p_user and not p.is_demo and p.disabled_at is null
  )
$$;

-- p_purpose belongs to p_user, or is shared with p_user by an active owner (a purpose seen only through a shared trip
-- does not count).
create or replace function private.purpose_usable_by(p_purpose uuid, p_user uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (select 1 from public.trip_purposes p where p.id = p_purpose and p.owner_id = p_user)
      or exists (
        select 1 from public.purpose_shares ps
         where ps.purpose_id = p_purpose and ps.grantee_id = p_user and private.is_active(ps.owner_id)
      )
$$;

revoke execute on function private.is_active(uuid) from public, anon;
revoke execute on function private.shared_trip_ids() from public, anon;
revoke execute on function private.writable_trip_ids() from public, anon;
revoke execute on function private.shared_plan_ids() from public, anon;
revoke execute on function private.writable_plan_ids() from public, anon;
revoke execute on function private.shared_group_ids() from public, anon;
revoke execute on function private.shared_purpose_ids() from public, anon;
revoke execute on function private.writable_purpose_ids() from public, anon;
revoke execute on function private.can_receive_share(uuid) from public, anon;
revoke execute on function private.purpose_usable_by(uuid, uuid) from public, anon;
grant execute on function private.is_active(uuid) to authenticated;
grant execute on function private.shared_trip_ids() to authenticated;
grant execute on function private.writable_trip_ids() to authenticated;
grant execute on function private.shared_plan_ids() to authenticated;
grant execute on function private.writable_plan_ids() to authenticated;
grant execute on function private.shared_group_ids() to authenticated;
grant execute on function private.shared_purpose_ids() to authenticated;
grant execute on function private.writable_purpose_ids() to authenticated;
grant execute on function private.can_receive_share(uuid) to authenticated;
grant execute on function private.purpose_usable_by(uuid, uuid) to authenticated;

-- ---------- policies of the share tables (no insert or update policy) ----------
drop policy if exists "trip_shares: owner or grantee select" on public.trip_shares;
create policy "trip_shares: owner or grantee select" on public.trip_shares
  for select to authenticated
  using ((select auth.uid()) = owner_id
         or ((select auth.uid()) = grantee_id and (select private.is_active(owner_id))));
drop policy if exists "trip_shares: owner or grantee delete" on public.trip_shares;
create policy "trip_shares: owner or grantee delete" on public.trip_shares
  for delete to authenticated
  using ((select auth.uid()) = owner_id or (select auth.uid()) = grantee_id);

drop policy if exists "purpose_shares: owner or grantee select" on public.purpose_shares;
create policy "purpose_shares: owner or grantee select" on public.purpose_shares
  for select to authenticated
  using ((select auth.uid()) = owner_id
         or ((select auth.uid()) = grantee_id and (select private.is_active(owner_id))));
drop policy if exists "purpose_shares: owner or grantee delete" on public.purpose_shares;
create policy "purpose_shares: owner or grantee delete" on public.purpose_shares
  for delete to authenticated
  using ((select auth.uid()) = owner_id or (select auth.uid()) = grantee_id);

-- ---------- 2.3 policies added to existing tables (the owner policies stay) ----------
drop policy if exists "trips: grantee select" on public.trips;
create policy "trips: grantee select" on public.trips
  for select to authenticated using (id = any ((select private.shared_trip_ids())::uuid[]));
drop policy if exists "trips: write grantee update" on public.trips;
create policy "trips: write grantee update" on public.trips
  for update to authenticated
  using (id = any ((select private.writable_trip_ids())::uuid[]))
  with check (id = any ((select private.writable_trip_ids())::uuid[]));

drop policy if exists "plans: grantee select" on public.plans;
create policy "plans: grantee select" on public.plans
  for select to authenticated using (id = any ((select private.shared_plan_ids())::uuid[]));
drop policy if exists "plans: write grantee insert" on public.plans;
create policy "plans: write grantee insert" on public.plans
  for insert to authenticated with check (trip_id = any ((select private.writable_trip_ids())::uuid[]));
drop policy if exists "plans: write grantee update" on public.plans;
create policy "plans: write grantee update" on public.plans
  for update to authenticated
  using (id = any ((select private.writable_plan_ids())::uuid[]))
  with check (id = any ((select private.writable_plan_ids())::uuid[]));

drop policy if exists "plan_versions: grantee select" on public.plan_versions;
create policy "plan_versions: grantee select" on public.plan_versions
  for select to authenticated using (plan_id = any ((select private.shared_plan_ids())::uuid[]));
drop policy if exists "plan_versions: write grantee insert" on public.plan_versions;
create policy "plan_versions: write grantee insert" on public.plan_versions
  for insert to authenticated with check (plan_id = any ((select private.writable_plan_ids())::uuid[]));

drop policy if exists "trip_items: grantee select" on public.trip_items;
create policy "trip_items: grantee select" on public.trip_items
  for select to authenticated using (trip_id = any ((select private.shared_trip_ids())::uuid[]));
drop policy if exists "trip_items: write grantee insert" on public.trip_items;
create policy "trip_items: write grantee insert" on public.trip_items
  for insert to authenticated with check (trip_id = any ((select private.writable_trip_ids())::uuid[]));
drop policy if exists "trip_items: write grantee update" on public.trip_items;
create policy "trip_items: write grantee update" on public.trip_items
  for update to authenticated
  using (trip_id = any ((select private.writable_trip_ids())::uuid[]))
  with check (trip_id = any ((select private.writable_trip_ids())::uuid[]));
drop policy if exists "trip_items: write grantee delete" on public.trip_items;
create policy "trip_items: write grantee delete" on public.trip_items
  for delete to authenticated using (trip_id = any ((select private.writable_trip_ids())::uuid[]));

drop policy if exists "travel_groups: grantee select" on public.travel_groups;
create policy "travel_groups: grantee select" on public.travel_groups
  for select to authenticated using (id = any ((select private.shared_group_ids())::uuid[]));
drop policy if exists "group_entries: grantee select" on public.group_entries;
create policy "group_entries: grantee select" on public.group_entries
  for select to authenticated using (group_id = any ((select private.shared_group_ids())::uuid[]));

drop policy if exists "trip_purposes: grantee select" on public.trip_purposes;
create policy "trip_purposes: grantee select" on public.trip_purposes
  for select to authenticated using (id = any ((select private.shared_purpose_ids())::uuid[]));
drop policy if exists "trip_purposes: write grantee update" on public.trip_purposes;
create policy "trip_purposes: write grantee update" on public.trip_purposes
  for update to authenticated
  using (id = any ((select private.writable_purpose_ids())::uuid[]))
  with check (id = any ((select private.writable_purpose_ids())::uuid[]));

-- ---------- 2.4 owner of child rows written by a grantee ----------
-- owner_id defaults to auth.uid(), which would be the grantee and break the composite FK. A before-insert trigger sets
-- it from the parent, always. RLS with check runs after before-triggers, so a stranger's insert gets the real owner's
-- id and then fails the policy (42501). An unknown parent leaves owner_id null and fails not null.
create or replace function private.inherit_trip_owner()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  new.owner_id := (select t.owner_id from public.trips t where t.id = new.trip_id);
  return new;
end;
$$;

create or replace function private.inherit_plan_owner()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  new.owner_id := (select p.owner_id from public.plans p where p.id = new.plan_id);
  return new;
end;
$$;
revoke all on function private.inherit_trip_owner() from public, anon, authenticated;
revoke all on function private.inherit_plan_owner() from public, anon, authenticated;

-- The _00_ prefix matters: same-event triggers fire in name order, and plan_versions_assign_no needs the final
-- owner_id (it updates plans ... where owner_id = new.owner_id).
drop trigger if exists plans_00_inherit_owner on public.plans;
create trigger plans_00_inherit_owner
  before insert on public.plans
  for each row execute function private.inherit_trip_owner();
drop trigger if exists trip_items_00_inherit_owner on public.trip_items;
create trigger trip_items_00_inherit_owner
  before insert on public.trip_items
  for each row execute function private.inherit_trip_owner();
drop trigger if exists plan_versions_00_inherit_owner on public.plan_versions;
create trigger plan_versions_00_inherit_owner
  before insert on public.plan_versions
  for each row execute function private.inherit_plan_owner();

-- ---------- 2.5 owner-only columns and purpose references ----------
-- Owner and grantee are both the `authenticated` role, so a column grant cannot tell them apart: a trigger does.
-- It guards statements run as a user: current_user = 'authenticated' (a PostgREST call with a user JWT) and a user who
-- is not the owner. It passes a null auth.uid() (secret key, e.g. the group_parsed cache write) and every other role.
-- That also keeps the system's own writes working: when the purpose owner deletes or unshares a purpose, the foreign-key
-- action and private.purpose_share_removed() (security definer) clear purpose_id on the RECIPIENT's trip while
-- auth.uid() is the purpose owner. Both run as the table owner, not as `authenticated`, so they pass; a user's own
-- statement cannot reach that role (no security definer function lets a user write these columns).
create or replace function private.trips_owner_only()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or v_uid = old.owner_id or current_user <> 'authenticated' then
    return new;
  end if;
  if new.group_id is distinct from old.group_id
     or new.group_text is distinct from old.group_text
     or new.group_structure is distinct from old.group_structure
     or new.purpose_id is distinct from old.purpose_id then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.trips_owner_only() from public, anon, authenticated;

-- The _00_ prefix again: same-event triggers fire in name order, and the owner-only check must come before
-- trips_check_purpose_ref, so a non-owner always gets 42501 for these columns, whatever value they try to set.
drop trigger if exists trips_00_owner_only on public.trips;
create trigger trips_00_owner_only
  before update on public.trips
  for each row execute function private.trips_owner_only();

-- trips and destination_searches: the composite same-owner FK on purpose_id becomes a plain FK plus a trigger that
-- allows the row owner's own purposes and purposes shared with the row owner. group_id keeps its composite FK.
alter table public.trips drop constraint if exists trips_purpose_id_owner_id_fkey;
alter table public.destination_searches drop constraint if exists destination_searches_purpose_id_owner_id_fkey;
alter table public.trips drop constraint if exists trips_purpose_id_fkey;
alter table public.trips
  add constraint trips_purpose_id_fkey foreign key (purpose_id) references public.trip_purposes (id) on delete set null;
alter table public.destination_searches drop constraint if exists destination_searches_purpose_id_fkey;
alter table public.destination_searches
  add constraint destination_searches_purpose_id_fkey
  foreign key (purpose_id) references public.trip_purposes (id) on delete set null;
create index if not exists destination_searches_purpose_idx
  on public.destination_searches (purpose_id) where purpose_id is not null;

-- security definer: the check must also work for writes with the secret key (demo reset script).
-- An unchanged purpose_id on update is not re-checked (as the old FK did not), so a row whose purpose owner got
-- disabled can still be edited.
create or replace function private.check_purpose_ref()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if new.purpose_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.purpose_id is not distinct from old.purpose_id then
    return new;
  end if;
  if not private.purpose_usable_by(new.purpose_id, new.owner_id) then
    raise exception 'purpose_not_usable' using errcode = '23503';
  end if;
  return new;
end;
$$;
revoke all on function private.check_purpose_ref() from public, anon, authenticated;

drop trigger if exists trips_check_purpose_ref on public.trips;
create trigger trips_check_purpose_ref
  before insert or update of purpose_id on public.trips
  for each row execute function private.check_purpose_ref();
drop trigger if exists destination_searches_check_purpose_ref on public.destination_searches;
create trigger destination_searches_check_purpose_ref
  before insert or update of purpose_id on public.destination_searches
  for each row execute function private.check_purpose_ref();

-- Unshare or leave a purpose: the grantee's own trips and searches lose the reference. The trips get a new updated_at
-- (their plans show as outdated; plan versions keep their snapshot). A search keeps its purpose_name snapshot and cards.
create or replace function private.purpose_share_removed()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  update public.trips set purpose_id = null
   where owner_id = old.grantee_id and purpose_id = old.purpose_id;
  update public.destination_searches set purpose_id = null
   where owner_id = old.grantee_id and purpose_id = old.purpose_id;
  return null;
end;
$$;
revoke all on function private.purpose_share_removed() from public, anon, authenticated;

drop trigger if exists purpose_shares_removed on public.purpose_shares;
create trigger purpose_shares_removed
  after delete on public.purpose_shares
  for each row execute function private.purpose_share_removed();

-- ---------- 2.6 plans, versions, lock ----------
alter table public.plans
  add column if not exists busy_by uuid references auth.users (id) on delete set null;

create or replace function private.plans_busy_by()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.busy_by := case when new.busy_until is null then null else (select auth.uid()) end;
  return new;
end;
$$;
revoke all on function private.plans_busy_by() from public, anon, authenticated;

drop trigger if exists plans_busy_by on public.plans;
create trigger plans_busy_by
  before update of busy_until on public.plans
  for each row execute function private.plans_busy_by();

-- Not in the insert grant: set by its default only.
alter table public.plan_versions
  add column if not exists created_by uuid default auth.uid() references auth.users (id) on delete set null;

-- Keeps the last 30 versions (mirrors MAX_VERSIONS_KEPT in src/lib/domain/plan.ts; a unit test compares them).
-- The plan_versions delete policy stays owner-only, so a write grantee can never delete history directly.
create or replace function public.prune_plan_versions(p_plan_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_latest integer;
begin
  select p.latest_version into v_latest
    from public.plans p
   where p.id = p_plan_id
     and (p.owner_id = (select auth.uid()) or p.id = any (private.writable_plan_ids()));
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.plan_versions where plan_id = p_plan_id and version_no <= v_latest - 30;
end;
$$;
revoke all on function public.prune_plan_versions(uuid) from public, anon;
grant execute on function public.prune_plan_versions(uuid) to authenticated;

-- ---------- 2.7 lookups for the server ----------
-- service_role only. Account by email for the share form. null for unknown, demo or disabled accounts.
create or replace function public.share_user_by_email(p_email text)
  returns uuid
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select u.id
    from auth.users u
   where lower(u.email) = lower(p_email) and private.can_receive_share(u.id)
   limit 1
$$;
revoke all on function public.share_user_by_email(text) from public, anon, authenticated;
grant execute on function public.share_user_by_email(text) to service_role;

-- authenticated. Name and email of every user the caller shares with or receives from (both tables, both directions).
-- Returns only counterparts of the caller's own share rows. Owners of incoming shares only while active; grantees of
-- the caller's own shares always (the owner chose them and may want to remove a disabled one).
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
    select s.owner_id from public.trip_shares s
     where s.grantee_id = (select auth.uid()) and private.is_active(s.owner_id)
    union
    select s.owner_id from public.purpose_shares s
     where s.grantee_id = (select auth.uid()) and private.is_active(s.owner_id)
  )
  select p.id, p.display_name, u.email::text
    from c
    join public.profiles p on p.id = c.uid
    join auth.users u on u.id = c.uid
$$;
revoke all on function public.share_contacts() from public, anon;
grant execute on function public.share_contacts() to authenticated;

-- ---------- 2.8 admin aggregate ----------
-- service_role only, counts only: no ids, emails or titles.
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
    'tripsShared',           (select count(distinct trip_id) from public.trip_shares),
    'recipients',            (select count(distinct g) from (
                               select grantee_id as g from public.trip_shares
                               union all
                               select grantee_id from public.purpose_shares) x),
    'grantsThisMonth',       (select count(*) from public.trip_shares where created_at >= p_month_start)
                             + (select count(*) from public.purpose_shares where created_at >= p_month_start),
    'lookupsThisMonth',      (select count(*) from public.app_events
                               where event = 'sharing.lookup' and created_at >= p_month_start),
    'lookupMissesThisMonth', (select count(*) from public.app_events
                               where event = 'sharing.lookup' and created_at >= p_month_start
                                 and props ->> 'found' = 'false')
  )
$$;
revoke all on function public.admin_share_stats(timestamptz) from public, anon, authenticated;
grant execute on function public.admin_share_stats(timestamptz) to service_role;

-- ---------- 2.9 share_resource: the only write path for grants ----------
-- Called only by the server action with the secret key, after the server authorized the session. Trusts nothing it is
-- given and checks again, in this order. Errors: raise exception '<code>' using errcode 'P0001'; the server maps the
-- message. MAX 10 grantees per resource (mirrored by MAX_SHARES_PER_RESOURCE; a unit test compares them).
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
     or p_resource not in ('trip', 'purpose') or p_access not in ('read', 'write') then
    raise exception 'invalid' using errcode = 'P0001';
  end if;

  -- 2. owner: has a profile, is not the demo account, is not disabled
  if not exists (select 1 from public.profiles p where p.id = p_owner and not p.is_demo)
     or not private.is_active(p_owner) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  -- 3. resource: owned by p_owner. The row lock serializes every concurrent call for this resource; for no key update
  -- does not block the key-share locks that item, plan and share inserts take through their foreign keys.
  if p_resource = 'trip' then
    perform 1 from public.trips t where t.id = p_resource_id and t.owner_id = p_owner for no key update;
  else
    perform 1 from public.trip_purposes tp where tp.id = p_resource_id and tp.owner_id = p_owner for no key update;
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
  else
    select s.id into v_existing from public.purpose_shares s
     where s.purpose_id = p_resource_id and s.grantee_id = p_grantee;
  end if;
  if p_share_id is not null and (v_existing is null or v_existing <> p_share_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_existing is not null then
    if p_resource = 'trip' then
      update public.trip_shares s set access = p_access where s.id = v_existing and s.access <> p_access;
    else
      update public.purpose_shares s set access = p_access where s.id = v_existing and s.access <> p_access;
    end if;
    return query select v_existing, false;
    return;
  end if;

  -- 6. cap, under the lock of step 3
  if p_resource = 'trip' then
    select count(*) into v_count from public.trip_shares s where s.trip_id = p_resource_id;
  else
    select count(*) into v_count from public.purpose_shares s where s.purpose_id = p_resource_id;
  end if;
  if v_count >= 10 then
    raise exception 'limit_reached' using errcode = 'P0001';
  end if;

  -- 7. insert
  if p_resource = 'trip' then
    insert into public.trip_shares (owner_id, trip_id, grantee_id, access)
      values (p_owner, p_resource_id, p_grantee, p_access) returning id into v_new_id;
  else
    insert into public.purpose_shares (owner_id, purpose_id, grantee_id, access)
      values (p_owner, p_resource_id, p_grantee, p_access) returning id into v_new_id;
  end if;
  return query select v_new_id, true;
end;
$$;
revoke all on function public.share_resource(uuid, text, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.share_resource(uuid, text, uuid, uuid, text, uuid) to service_role;
