-- Share city tours between users and by public link (docs/specs/city-tour.md 9.3, 17.1 [P4], 17.4; CLAUDE.md rule 6
-- since #225). Forward-only and additive, extends 20261110120035_sharing.sql and 20261112120037_group_sharing.sql.
-- Safe to deploy alone: every new policy depends on a tour_shares row or a share_links row with tour_id, and after this
-- migration no client can create either for a tour (tour_shares: no insert grant, public.share_resource is executable
-- by service_role only and the deployed server's Zod enum rejects 'tour'; share_links: tour_id is not in the insert
-- grant until the server PR needs it, see the end of this file).
--
-- Deploy order: this migration first, then the server PR.

-- ---------- tour_shares (like group_shares) ----------
-- owner_id has no default: it is set by public.share_resource from its checked p_owner argument.
create table if not exists public.tour_shares (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  tour_id     uuid not null,
  grantee_id  uuid not null references auth.users (id) on delete cascade,
  access      text not null default 'read' check (access in ('read', 'write')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tour_id, owner_id) references public.city_tours (id, owner_id) on delete cascade,
  constraint tour_shares_not_self check (grantee_id <> owner_id),
  constraint tour_shares_tour_grantee_key unique (tour_id, grantee_id)
);
create index if not exists tour_shares_grantee_idx on public.tour_shares (grantee_id, created_at desc);
create index if not exists tour_shares_owner_idx on public.tour_shares (owner_id);

drop trigger if exists tour_shares_set_updated_at on public.tour_shares;
create trigger tour_shares_set_updated_at
  before update on public.tour_shares
  for each row execute function private.set_updated_at();

alter table public.tour_shares enable row level security;

-- No insert and no update grant: rows are created and their access changed only by public.share_resource.
revoke all on table public.tour_shares from anon, authenticated, public;
grant select, delete on public.tour_shares to authenticated;
grant select, insert, update, delete on public.tour_shares to service_role;

drop policy if exists "tour_shares: owner or grantee select" on public.tour_shares;
create policy "tour_shares: owner or grantee select" on public.tour_shares
  for select to authenticated
  using ((select auth.uid()) = owner_id
         or ((select auth.uid()) = grantee_id and (select private.is_active(owner_id))));
drop policy if exists "tour_shares: owner or grantee delete" on public.tour_shares;
create policy "tour_shares: owner or grantee delete" on public.tour_shares
  for delete to authenticated
  using ((select auth.uid()) = owner_id or (select auth.uid()) = grantee_id);

-- ---------- helper functions (security definer, empty search_path) ----------
-- Tours shared with me directly, only while their owner is active. Tours seen through a shared trip stay on the
-- existing "city_tours: trip grantee select" policy (read-only).
create or replace function private.shared_tour_ids()
  returns uuid[]
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select array(
    select ts.tour_id from public.tour_shares ts
     where ts.grantee_id = (select auth.uid()) and private.is_active(ts.owner_id)
  )
$$;

create or replace function private.writable_tour_ids()
  returns uuid[]
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select array(
    select ts.tour_id from public.tour_shares ts
     where ts.grantee_id = (select auth.uid()) and ts.access = 'write' and private.is_active(ts.owner_id)
  )
$$;

revoke execute on function private.shared_tour_ids() from public, anon;
revoke execute on function private.writable_tour_ids() from public, anon;
grant execute on function private.shared_tour_ids() to authenticated;
grant execute on function private.writable_tour_ids() to authenticated;

-- ---------- city_tours policies for grantees (owner policies and the trip grantee policy stay) ----------
drop policy if exists "city_tours: tour grantee select" on public.city_tours;
create policy "city_tours: tour grantee select" on public.city_tours
  for select to authenticated using (id = any ((select private.shared_tour_ids())::uuid[]));
-- Write grantees edit title and input (the column grant is unchanged). No grantee insert or delete policy.
drop policy if exists "city_tours: write grantee update" on public.city_tours;
create policy "city_tours: write grantee update" on public.city_tours
  for update to authenticated
  using (id = any ((select private.writable_tour_ids())::uuid[]))
  with check (id = any ((select private.writable_tour_ids())::uuid[]));

-- The trip link is the owner's: the composite FK only checks that the trip belongs to the TOUR owner, so without this
-- guard a write grantee could attach the tour to any of the owner's trips. Acts only on user statements (the secret
-- key, FK actions and definer functions pass untouched), like private.group_entries_guard.
create or replace function private.city_tours_grantee_guard()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or current_user <> 'authenticated' or v_uid = old.owner_id then
    return new;
  end if;
  if new.trip_id is distinct from old.trip_id or new.trip_day is distinct from old.trip_day then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.city_tours_grantee_guard() from public, anon, authenticated;

-- _00_ sorts before city_tours_set_updated_at.
drop trigger if exists city_tours_00_grantee_guard on public.city_tours;
create trigger city_tours_00_grantee_guard
  before update on public.city_tours
  for each row execute function private.city_tours_grantee_guard();

-- ---------- share_links: a link points at a trip OR a standalone tour ----------
alter table public.share_links alter column trip_id drop not null;
alter table public.share_links add column if not exists tour_id uuid;
alter table public.share_links drop constraint if exists share_links_tour_fkey;
alter table public.share_links add constraint share_links_tour_fkey
  foreign key (tour_id, owner_id) references public.city_tours (id, owner_id) on delete cascade;
alter table public.share_links drop constraint if exists share_links_one_target;
alter table public.share_links add constraint share_links_one_target check (num_nonnulls(trip_id, tour_id) = 1);
create index if not exists share_links_tour_idx on public.share_links (tour_id) where tour_id is not null;
-- Owners read the column of their own links (select policy unchanged). The insert grant stays without tour_id: the
-- server creates tour links with the secret key after its own checks.
grant select (tour_id) on public.share_links to authenticated;

-- ---------- share_contacts, admin stats, share_resource (create or replace, same signatures) ----------
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
    select s.grantee_id from public.tour_shares s where s.owner_id = (select auth.uid())
    union
    select s.owner_id from public.trip_shares s
     where s.grantee_id = (select auth.uid()) and private.is_active(s.owner_id)
    union
    select s.owner_id from public.purpose_shares s
     where s.grantee_id = (select auth.uid()) and private.is_active(s.owner_id)
    union
    select s.owner_id from public.group_shares s
     where s.grantee_id = (select auth.uid()) and private.is_active(s.owner_id)
    union
    select s.owner_id from public.tour_shares s
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
    'tourSharesRead',        (select count(*) from public.tour_shares where access = 'read'),
    'tourSharesWrite',       (select count(*) from public.tour_shares where access = 'write'),
    'tripsShared',           (select count(distinct trip_id) from public.trip_shares),
    'groupsShared',          (select count(distinct group_id) from public.group_shares),
    'toursShared',           (select count(distinct tour_id) from public.tour_shares),
    'entryLinks',            (select count(*) from public.group_entries where linked_user_id is not null),
    'recipients',            (select count(distinct g) from (
                               select grantee_id as g from public.trip_shares
                               union all
                               select grantee_id from public.purpose_shares
                               union all
                               select grantee_id from public.group_shares
                               union all
                               select grantee_id from public.tour_shares) x),
    'grantsThisMonth',       (select count(*) from public.trip_shares where created_at >= p_month_start)
                             + (select count(*) from public.purpose_shares where created_at >= p_month_start)
                             + (select count(*) from public.group_shares where created_at >= p_month_start)
                             + (select count(*) from public.tour_shares where created_at >= p_month_start),
    'lookupsThisMonth',      (select count(*) from public.app_events
                               where event = 'sharing.lookup' and created_at >= p_month_start),
    'lookupMissesThisMonth', (select count(*) from public.app_events
                               where event = 'sharing.lookup' and created_at >= p_month_start
                                 and props ->> 'found' = 'false')
  )
$$;
revoke all on function public.admin_share_stats(timestamptz) from public, anon, authenticated;
grant execute on function public.admin_share_stats(timestamptz) to service_role;

-- Same as 20261112120037 section 2.9, plus p_resource = 'tour'. MAX 10 grantees per resource.
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
     or p_resource not in ('trip', 'purpose', 'group', 'tour') or p_access not in ('read', 'write') then
    raise exception 'invalid' using errcode = 'P0001';
  end if;

  -- 2. owner: has a profile, is not the demo account, is not disabled
  if not exists (select 1 from public.profiles p where p.id = p_owner and not p.is_demo)
     or not private.is_active(p_owner) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  -- 3. resource: owned by p_owner; the row lock serializes concurrent calls for this resource
  if p_resource = 'trip' then
    perform 1 from public.trips t where t.id = p_resource_id and t.owner_id = p_owner for no key update;
  elsif p_resource = 'purpose' then
    perform 1 from public.trip_purposes tp where tp.id = p_resource_id and tp.owner_id = p_owner for no key update;
  elsif p_resource = 'group' then
    perform 1 from public.travel_groups g where g.id = p_resource_id and g.owner_id = p_owner for no key update;
  else
    perform 1 from public.city_tours ct where ct.id = p_resource_id and ct.owner_id = p_owner for no key update;
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

  -- 5. existing grant: change the level (update-only with p_share_id)
  if p_resource = 'trip' then
    select s.id into v_existing from public.trip_shares s
     where s.trip_id = p_resource_id and s.grantee_id = p_grantee;
  elsif p_resource = 'purpose' then
    select s.id into v_existing from public.purpose_shares s
     where s.purpose_id = p_resource_id and s.grantee_id = p_grantee;
  elsif p_resource = 'group' then
    select s.id into v_existing from public.group_shares s
     where s.group_id = p_resource_id and s.grantee_id = p_grantee;
  else
    select s.id into v_existing from public.tour_shares s
     where s.tour_id = p_resource_id and s.grantee_id = p_grantee;
  end if;
  if p_share_id is not null and (v_existing is null or v_existing <> p_share_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_existing is not null then
    if p_resource = 'trip' then
      update public.trip_shares s set access = p_access where s.id = v_existing and s.access <> p_access;
    elsif p_resource = 'purpose' then
      update public.purpose_shares s set access = p_access where s.id = v_existing and s.access <> p_access;
    elsif p_resource = 'group' then
      update public.group_shares s set access = p_access where s.id = v_existing and s.access <> p_access;
    else
      update public.tour_shares s set access = p_access where s.id = v_existing and s.access <> p_access;
    end if;
    return query select v_existing, false;
    return;
  end if;

  -- 6. cap, under the lock of step 3
  if p_resource = 'trip' then
    select count(*) into v_count from public.trip_shares s where s.trip_id = p_resource_id;
  elsif p_resource = 'purpose' then
    select count(*) into v_count from public.purpose_shares s where s.purpose_id = p_resource_id;
  elsif p_resource = 'group' then
    select count(*) into v_count from public.group_shares s where s.group_id = p_resource_id;
  else
    select count(*) into v_count from public.tour_shares s where s.tour_id = p_resource_id;
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
  elsif p_resource = 'group' then
    insert into public.group_shares (owner_id, group_id, grantee_id, access)
      values (p_owner, p_resource_id, p_grantee, p_access) returning id into v_new_id;
  else
    insert into public.tour_shares (owner_id, tour_id, grantee_id, access)
      values (p_owner, p_resource_id, p_grantee, p_access) returning id into v_new_id;
  end if;
  return query select v_new_id, true;
end;
$$;
revoke all on function public.share_resource(uuid, text, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.share_resource(uuid, text, uuid, uuid, text, uuid) to service_role;
