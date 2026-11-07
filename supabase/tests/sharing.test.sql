-- pgTAP tests for sharing trips and purposes (migration 20261110120035, docs/specs/sharing.md sections 2 and 5).
-- Run with `supabase test db`. One transaction, rolled back. now() is constant inside it.
-- Actors: A owner, B write grantee, C read grantee, D stranger, E demo, F owner who gets disabled, G01..G11 extra users
-- (cap tests). Share rows are created with public.share_resource as service_role, the only write path.
-- Convention: `reset role; set local request.jwt.claims = '{}'` before a postgres section (auth.uid() = null),
-- `set local request.jwt.claims = '{"sub":...}'; set local role authenticated` to act as a user.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select * from no_plan();

-- ---------- fixtures (as postgres) ----------
insert into public.signup_allowlist (email) values
  ('a@share.test'), ('b@share.test'), ('c@share.test'), ('d@share.test'), ('e@share.test'), ('f@share.test');
insert into public.signup_allowlist (email) select 'g' || g || '@share.test' from generate_series(1, 11) g;
insert into auth.users (id, email, raw_user_meta_data, aud, role) values
  ('5a000000-0000-4000-8000-0000000000a1', 'a@share.test', '{}', 'authenticated', 'authenticated'),
  ('5a000000-0000-4000-8000-0000000000b2', 'b@share.test', '{}', 'authenticated', 'authenticated'),
  ('5a000000-0000-4000-8000-0000000000c3', 'c@share.test', '{}', 'authenticated', 'authenticated'),
  ('5a000000-0000-4000-8000-0000000000d4', 'd@share.test', '{}', 'authenticated', 'authenticated'),
  ('5a000000-0000-4000-8000-0000000000e5', 'e@share.test', '{}', 'authenticated', 'authenticated'),
  ('5a000000-0000-4000-8000-0000000000f6', 'f@share.test', '{}', 'authenticated', 'authenticated');
insert into auth.users (id, email, raw_user_meta_data, aud, role)
select ('5a000000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'g' || g || '@share.test', '{}', 'authenticated', 'authenticated'
  from generate_series(1, 11) g;
update public.profiles set is_demo = true where id = '5a000000-0000-4000-8000-0000000000e5';
update public.profiles set display_name = 'Alice' where id = '5a000000-0000-4000-8000-0000000000a1';
update public.profiles set display_name = 'Bob' where id = '5a000000-0000-4000-8000-0000000000b2';

insert into public.trip_purposes (id, owner_id, name, text) values
  ('5a000000-0000-4000-8000-00000000a101', '5a000000-0000-4000-8000-0000000000a1', 'A golf', 'golf text'),
  ('5a000000-0000-4000-8000-00000000a102', '5a000000-0000-4000-8000-0000000000a1', 'A spa', null),
  ('5a000000-0000-4000-8000-00000000a103', '5a000000-0000-4000-8000-0000000000a1', 'A hidden', null),
  ('5a000000-0000-4000-8000-00000000a104', '5a000000-0000-4000-8000-0000000000a1', 'A to delete', null),
  ('5a000000-0000-4000-8000-00000000a105', '5a000000-0000-4000-8000-0000000000a1', 'A cascade', null),
  ('5a000000-0000-4000-8000-00000000b101', '5a000000-0000-4000-8000-0000000000b2', 'B beach', null),
  ('5a000000-0000-4000-8000-00000000f101', '5a000000-0000-4000-8000-0000000000f6', 'F ski', null);
insert into public.travel_groups (id, owner_id, name) values
  ('5a000000-0000-4000-8000-00000000a001', '5a000000-0000-4000-8000-0000000000a1', 'A family'), ('5a000000-0000-4000-8000-00000000a002', '5a000000-0000-4000-8000-0000000000a1', 'A other'), ('5a000000-0000-4000-8000-00000000b001', '5a000000-0000-4000-8000-0000000000b2', 'B group'), ('5a000000-0000-4000-8000-00000000f001', '5a000000-0000-4000-8000-0000000000f6', 'F group');
insert into public.group_entries (group_id, owner_id, kind, count) values
  ('5a000000-0000-4000-8000-00000000a001', '5a000000-0000-4000-8000-0000000000a1', 'composition', 2), ('5a000000-0000-4000-8000-00000000a002', '5a000000-0000-4000-8000-0000000000a1', 'composition', 1),
  ('5a000000-0000-4000-8000-00000000b001', '5a000000-0000-4000-8000-0000000000b2', 'composition', 1), ('5a000000-0000-4000-8000-00000000f001', '5a000000-0000-4000-8000-0000000000f6', 'composition', 1);
insert into public.group_entries (group_id, owner_id, kind, is_self) values ('5a000000-0000-4000-8000-00000000a001', '5a000000-0000-4000-8000-0000000000a1', 'member', true);
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, group_id, purpose_id) values
  ('5a000000-0000-4000-8000-00000000a201',  '5a000000-0000-4000-8000-0000000000a1', 'freetext', 'A trip',        3, '5a000000-0000-4000-8000-00000000a001',  '5a000000-0000-4000-8000-00000000a101'),
  ('5a000000-0000-4000-8000-00000000a202', '5a000000-0000-4000-8000-0000000000a1', 'freetext', 'A other trip',  3, '5a000000-0000-4000-8000-00000000a002', null),
  ('5a000000-0000-4000-8000-00000000a203', '5a000000-0000-4000-8000-0000000000a1', 'freetext', 'A cap trip',    3, null,    null),
  ('5a000000-0000-4000-8000-00000000a204',  '5a000000-0000-4000-8000-0000000000a1', 'freetext', 'A write trip',  3, null,    null),
  ('5a000000-0000-4000-8000-00000000a205',  '5a000000-0000-4000-8000-0000000000a1', 'freetext', 'A purpose trip', 3, null,   '5a000000-0000-4000-8000-00000000a103'),
  ('5a000000-0000-4000-8000-00000000b201',  '5a000000-0000-4000-8000-0000000000b2', 'freetext', 'B trip',        3, '5a000000-0000-4000-8000-00000000b001',  '5a000000-0000-4000-8000-00000000b101'),
  ('5a000000-0000-4000-8000-00000000c201',  '5a000000-0000-4000-8000-0000000000c3', 'freetext', 'C trip',        3, null,    null),
  ('5a000000-0000-4000-8000-00000000d201',  '5a000000-0000-4000-8000-0000000000d4', 'freetext', 'D trip',        3, null,    null),
  ('5a000000-0000-4000-8000-00000000f201',  '5a000000-0000-4000-8000-0000000000f6', 'freetext', 'F trip',        3, '5a000000-0000-4000-8000-00000000f001',  '5a000000-0000-4000-8000-00000000f101');
insert into public.plans (id, owner_id, trip_id) values
  ('5a000000-0000-4000-8000-00000000a301', '5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-00000000a201'), ('5a000000-0000-4000-8000-00000000a302', '5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-00000000a202'), ('5a000000-0000-4000-8000-00000000b301', '5a000000-0000-4000-8000-0000000000b2', '5a000000-0000-4000-8000-00000000b201'), ('5a000000-0000-4000-8000-00000000f301', '5a000000-0000-4000-8000-0000000000f6', '5a000000-0000-4000-8000-00000000f201');
insert into public.plan_versions (plan_id, kind, plan, input, input_hash) values
  ('5a000000-0000-4000-8000-00000000a301', 'generate', '{"v":1}', '{}', repeat('a', 64)),
  ('5a000000-0000-4000-8000-00000000a301', 'patch',    '{"v":2}', '{}', repeat('a', 64)),
  ('5a000000-0000-4000-8000-00000000a302', 'generate', '{"v":1}', '{}', repeat('a', 64)),
  ('5a000000-0000-4000-8000-00000000b301', 'generate', '{"v":1}', '{}', repeat('b', 64)),
  ('5a000000-0000-4000-8000-00000000f301', 'generate', '{"v":1}', '{}', repeat('f', 64));
insert into public.trip_items (id, trip_id, category, title) values
  ('5a000000-0000-4000-8000-00000000a501', '5a000000-0000-4000-8000-00000000a201', 'stay', 'A hotel'), ('5a000000-0000-4000-8000-00000000b501', '5a000000-0000-4000-8000-00000000b201', 'stay', 'B hotel'), ('5a000000-0000-4000-8000-00000000f501', '5a000000-0000-4000-8000-00000000f201', 'stay', 'F hotel');
insert into public.share_links (id, owner_id, trip_id, token_hash) values ('5a000000-0000-4000-8000-00000000a601', '5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-00000000a201', repeat('c', 64));

select is((select owner_id from public.plans where id = '5a000000-0000-4000-8000-00000000a301'), '5a000000-0000-4000-8000-0000000000a1'::uuid, 'fixture: inherit trigger keeps the owner for a postgres insert');
select is((select count(*)::int from public.plan_versions where plan_id = '5a000000-0000-4000-8000-00000000a301' and owner_id = '5a000000-0000-4000-8000-0000000000a1'), 2, 'fixture: versions inherit owner_id from the plan');
select is((select owner_id from public.trip_items where id = '5a000000-0000-4000-8000-00000000a501'), '5a000000-0000-4000-8000-0000000000a1'::uuid, 'fixture: items inherit owner_id from the trip');

-- ---------- structure ----------
select ok((select relrowsecurity from pg_class where oid = 'public.trip_shares'::regclass), 'RLS enabled on trip_shares');
select ok((select relrowsecurity from pg_class where oid = 'public.purpose_shares'::regclass), 'RLS enabled on purpose_shares');
select ok(not exists (
  select 1 from pg_constraint c
   where c.conrelid in ('public.trips'::regclass, 'public.destination_searches'::regclass)
     and c.contype = 'f' and c.confrelid = 'public.trip_purposes'::regclass and cardinality(c.conkey) = 2),
  'no composite purpose FK left on trips and destination_searches');
select is((select count(*)::int from pg_constraint c
   where c.conrelid in ('public.trips'::regclass, 'public.destination_searches'::regclass)
     and c.contype = 'f' and c.confrelid = 'public.trip_purposes'::regclass and cardinality(c.conkey) = 1
     and c.confdeltype = 'n'), 2, 'plain purpose FK with on delete set null on trips and destination_searches');
-- group sharing (migration 20261112120037) replaced the composite group FK with a plain one plus check_group_ref
select is((select count(*)::int from pg_constraint c
   where c.conrelid in ('public.trips'::regclass, 'public.destination_searches'::regclass)
     and c.contype = 'f' and c.confrelid = 'public.travel_groups'::regclass and cardinality(c.conkey) = 2), 0,
  'group_id has no composite same-owner FK any more (group-sharing.test.sql covers the plain FK)');
select is((select array_agg(t.tgname::text order by t.tgname) from pg_trigger t
   where t.tgrelid = 'public.plan_versions'::regclass and not t.tgisinternal and (t.tgtype & 6) = 6),
  array['plan_versions_00_inherit_owner', 'plan_versions_assign_no'],
  'plan_versions: inherit-owner trigger fires before plan_versions_assign_no (name order)');
select is((select array_agg(t.tgname::text order by t.tgname) from pg_trigger t
   where t.tgrelid = 'public.plans'::regclass and not t.tgisinternal and (t.tgtype & 6) = 6),
  array['plans_00_inherit_owner'], 'plans: inherit-owner trigger is the first before-insert trigger');
select is((select array_agg(t.tgname::text order by t.tgname) from pg_trigger t
   where t.tgrelid = 'public.trip_items'::regclass and not t.tgisinternal and (t.tgtype & 6) = 6),
  array['trip_items_00_inherit_owner', 'trip_items_cap'], 'trip_items: inherit-owner trigger fires before the cap trigger');

-- ---------- No share rows yet: the widened policies add nothing ----------
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trips where owner_id <> (select auth.uid())), 0, 'no share rows: B sees only own rows in trips');
select is((select count(*)::int from public.plans where owner_id <> (select auth.uid())), 0, 'no share rows: B sees only own rows in plans');
select is((select count(*)::int from public.plan_versions where owner_id <> (select auth.uid())), 0, 'no share rows: B sees only own rows in plan_versions');
select is((select count(*)::int from public.trip_items where owner_id <> (select auth.uid())), 0, 'no share rows: B sees only own rows in trip_items');
select is((select count(*)::int from public.travel_groups where owner_id <> (select auth.uid())), 0, 'no share rows: B sees only own rows in travel_groups');
select is((select count(*)::int from public.group_entries where owner_id <> (select auth.uid())), 0, 'no share rows: B sees only own rows in group_entries');
select is((select count(*)::int from public.trip_purposes where owner_id <> (select auth.uid())), 0, 'no share rows: B sees only own rows in trip_purposes');
select is((select count(*)::int from public.trip_shares) + (select count(*)::int from public.purpose_shares), 0, 'no share rows: B sees no share rows');
select is((select private.shared_trip_ids()), '{}'::uuid[], 'no share rows: B shared_trip_ids is empty');
select is((select private.shared_purpose_ids()), '{}'::uuid[], 'no share rows: B shared_purpose_ids is empty');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trips where owner_id <> (select auth.uid())), 0, 'no share rows: C sees only own rows in trips');
select is((select count(*)::int from public.plans where owner_id <> (select auth.uid())), 0, 'no share rows: C sees only own rows in plans');
select is((select count(*)::int from public.plan_versions where owner_id <> (select auth.uid())), 0, 'no share rows: C sees only own rows in plan_versions');
select is((select count(*)::int from public.trip_items where owner_id <> (select auth.uid())), 0, 'no share rows: C sees only own rows in trip_items');
select is((select count(*)::int from public.travel_groups where owner_id <> (select auth.uid())), 0, 'no share rows: C sees only own rows in travel_groups');
select is((select count(*)::int from public.group_entries where owner_id <> (select auth.uid())), 0, 'no share rows: C sees only own rows in group_entries');
select is((select count(*)::int from public.trip_purposes where owner_id <> (select auth.uid())), 0, 'no share rows: C sees only own rows in trip_purposes');
select is((select count(*)::int from public.trip_shares) + (select count(*)::int from public.purpose_shares), 0, 'no share rows: C sees no share rows');
select is((select private.shared_trip_ids()), '{}'::uuid[], 'no share rows: C shared_trip_ids is empty');
select is((select private.shared_purpose_ids()), '{}'::uuid[], 'no share rows: C shared_purpose_ids is empty');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trips where owner_id <> (select auth.uid())), 0, 'no share rows: D sees only own rows in trips');
select is((select count(*)::int from public.plans where owner_id <> (select auth.uid())), 0, 'no share rows: D sees only own rows in plans');
select is((select count(*)::int from public.plan_versions where owner_id <> (select auth.uid())), 0, 'no share rows: D sees only own rows in plan_versions');
select is((select count(*)::int from public.trip_items where owner_id <> (select auth.uid())), 0, 'no share rows: D sees only own rows in trip_items');
select is((select count(*)::int from public.travel_groups where owner_id <> (select auth.uid())), 0, 'no share rows: D sees only own rows in travel_groups');
select is((select count(*)::int from public.group_entries where owner_id <> (select auth.uid())), 0, 'no share rows: D sees only own rows in group_entries');
select is((select count(*)::int from public.trip_purposes where owner_id <> (select auth.uid())), 0, 'no share rows: D sees only own rows in trip_purposes');
select is((select count(*)::int from public.trip_shares) + (select count(*)::int from public.purpose_shares), 0, 'no share rows: D sees no share rows');
select is((select private.shared_trip_ids()), '{}'::uuid[], 'no share rows: D shared_trip_ids is empty');
select is((select private.shared_purpose_ids()), '{}'::uuid[], 'no share rows: D shared_purpose_ids is empty');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trips), 1, 'no share rows: B sees exactly the one own trip');
select is((select count(*)::int from public.plans) + (select count(*)::int from public.plan_versions)
        + (select count(*)::int from public.trip_items) + (select count(*)::int from public.travel_groups)
        + (select count(*)::int from public.group_entries) + (select count(*)::int from public.trip_purposes), 6,
  'no share rows: B sees exactly its own plan, version, item, group, entry and purpose');
reset role;
set local request.jwt.claims = '{}';

-- ---------- write path: clients cannot create or change a share row ----------
select ok(not has_table_privilege('authenticated', 'public.trip_shares', 'insert'), 'authenticated: no insert on trip_shares');
select ok(not has_table_privilege('authenticated', 'public.trip_shares', 'update'), 'authenticated: no update on trip_shares');
select ok(not has_any_column_privilege('authenticated', 'public.trip_shares', 'insert'), 'authenticated: no column insert on trip_shares');
select ok(not has_any_column_privilege('authenticated', 'public.trip_shares', 'update'), 'authenticated: no column update on trip_shares');
select ok(not has_table_privilege('authenticated', 'public.purpose_shares', 'insert'), 'authenticated: no insert on purpose_shares');
select ok(not has_table_privilege('authenticated', 'public.purpose_shares', 'update'), 'authenticated: no update on purpose_shares');
select ok(not has_any_column_privilege('authenticated', 'public.purpose_shares', 'insert'), 'authenticated: no column insert on purpose_shares');
select ok(not has_any_column_privilege('authenticated', 'public.purpose_shares', 'update'), 'authenticated: no column update on purpose_shares');
select ok(has_table_privilege('authenticated', 'public.trip_shares', 'select') and has_table_privilege('authenticated', 'public.trip_shares', 'delete'), 'authenticated: select and delete on trip_shares');
select ok(not has_table_privilege('anon', 'public.trip_shares', 'select'), 'anon: no select on trip_shares');
select ok(not has_table_privilege('anon', 'public.purpose_shares', 'select'), 'anon: no select on purpose_shares');
select ok(has_function_privilege('service_role', 'public.share_resource(uuid,text,uuid,uuid,text,uuid)', 'execute'), 'service_role may execute share_resource');
select ok(not has_function_privilege('authenticated', 'public.share_resource(uuid,text,uuid,uuid,text,uuid)', 'execute'), 'authenticated may not execute share_resource');
select ok(not has_function_privilege('anon', 'public.share_resource(uuid,text,uuid,uuid,text,uuid)', 'execute'), 'anon may not execute share_resource');
select ok(has_function_privilege('service_role', 'public.share_user_by_email(text)', 'execute'), 'service_role may execute share_user_by_email');
select ok(not has_function_privilege('authenticated', 'public.share_user_by_email(text)', 'execute'), 'authenticated may not execute share_user_by_email');
select ok(not has_function_privilege('anon', 'public.share_user_by_email(text)', 'execute'), 'anon may not execute share_user_by_email');
select ok(has_function_privilege('service_role', 'public.admin_share_stats(timestamptz)', 'execute'), 'service_role may execute admin_share_stats');
select ok(not has_function_privilege('authenticated', 'public.admin_share_stats(timestamptz)', 'execute'), 'authenticated may not execute admin_share_stats');
select ok(has_function_privilege('authenticated', 'public.share_contacts()', 'execute'), 'authenticated may execute share_contacts');
select ok(not has_function_privilege('anon', 'public.share_contacts()', 'execute'), 'anon may not execute share_contacts');
select ok(has_function_privilege('authenticated', 'public.prune_plan_versions(uuid)', 'execute'), 'authenticated may execute prune_plan_versions');
select ok(not has_function_privilege('anon', 'public.prune_plan_versions(uuid)', 'execute'), 'anon may not execute prune_plan_versions');
select ok(not has_function_privilege('authenticated', 'private.inherit_trip_owner()', 'execute'), 'trigger functions are not executable by authenticated');
select ok(not has_function_privilege('authenticated', 'private.can_receive_share(uuid)', 'execute'), 'authenticated may not probe can_receive_share');
select ok(not has_function_privilege('authenticated', 'private.purpose_usable_by(uuid, uuid)', 'execute'), 'authenticated may not probe purpose_usable_by');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and p.proname in ('is_active', 'shared_trip_ids', 'writable_trip_ids', 'shared_plan_ids',
              'writable_plan_ids', 'shared_group_ids', 'shared_purpose_ids', 'writable_purpose_ids', 'can_receive_share',
              'purpose_usable_by', 'inherit_trip_owner', 'inherit_plan_owner', 'check_purpose_ref', 'purpose_share_removed')),
  'helper and trigger functions are security definer with an empty search_path');

set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select throws_ok($$insert into public.trip_shares (owner_id, trip_id, grantee_id, access) values ('5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2', 'write')$$,
  '42501', null, 'A cannot insert a trip share directly, even with a valid grantee id');
select throws_ok($$insert into public.trip_shares (trip_id, grantee_id) values ('5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2')$$,
  '42501', null, 'A cannot insert a trip share with column defaults either');
select throws_ok($$insert into public.purpose_shares (owner_id, purpose_id, grantee_id, access) values ('5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-00000000a101', '5a000000-0000-4000-8000-0000000000b2', 'write')$$,
  '42501', null, 'A cannot insert a purpose share directly');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2', 'write')$$,
  '42501', null, 'authenticated cannot call share_resource');
reset role;
set local role anon;
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2', 'write')$$,
  '42501', null, 'anon cannot call share_resource');
select throws_ok($$select count(*) from public.trip_shares$$, '42501', null, 'anon cannot read trip_shares');
reset role;

-- ---------- share_resource as service_role ----------
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000b2', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000c3', 'read')$$,
  'P0001', 'not_found', 'B as p_owner for the trip of A: not_found');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000b201', '5a000000-0000-4000-8000-0000000000c3', 'read')$$,
  'P0001', 'not_found', 'A as p_owner for the trip of B: not_found');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'purpose', '5a000000-0000-4000-8000-00000000b101', '5a000000-0000-4000-8000-0000000000c3', 'read')$$,
  'P0001', 'not_found', 'A as p_owner for the purpose of B: not_found');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-0000000000ff', '5a000000-0000-4000-8000-0000000000c3', 'read')$$,
  'P0001', 'not_found', 'unknown trip: not_found');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000e5', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000c3', 'read')$$,
  'P0001', 'forbidden', 'demo account as owner: forbidden');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000ff', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000c3', 'read')$$,
  'P0001', 'forbidden', 'owner without a profile: forbidden');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000a1', 'read')$$,
  'P0001', 'self_share', 'sharing with oneself: self_share');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000e5', 'read')$$,
  'P0001', 'no_account', 'demo account as grantee: no_account');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000ff', 'read')$$,
  'P0001', 'no_account', 'unknown grantee id: no_account');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'plan', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2', 'read')$$,
  'P0001', 'invalid', 'unknown resource kind: invalid');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2', 'admin')$$,
  'P0001', 'invalid', 'unknown access level: invalid');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', null, 'read')$$,
  'P0001', 'invalid', 'null argument: invalid');
select is((select count(*)::int from public.trip_shares) + (select count(*)::int from public.purpose_shares), 0, 'failed calls created no share row');

select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2', 'write') s), true, 'A shares trip TA with B (write)');
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000c3', 'read') s), true, 'A shares trip TA with C (read)');
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a204', '5a000000-0000-4000-8000-0000000000b2', 'write') s), true, 'A shares trip TW with B (write)');
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a204', '5a000000-0000-4000-8000-0000000000c3', 'read') s), true, 'A shares trip TW with C (read)');
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a205', '5a000000-0000-4000-8000-0000000000b2', 'read') s), true, 'A shares trip TP (purpose PX) with B (read)');
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'purpose', '5a000000-0000-4000-8000-00000000a101', '5a000000-0000-4000-8000-0000000000b2', 'write') s), true, 'A shares purpose PA with B (write)');
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'purpose', '5a000000-0000-4000-8000-00000000a101', '5a000000-0000-4000-8000-0000000000c3', 'read') s), true, 'A shares purpose PA with C (read)');
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'purpose', '5a000000-0000-4000-8000-00000000a104', '5a000000-0000-4000-8000-0000000000c3', 'read') s), true, 'A shares purpose PD with C (read)');
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'purpose', '5a000000-0000-4000-8000-00000000a105', '5a000000-0000-4000-8000-0000000000c3', 'read') s), true, 'A shares purpose PE with C (read)');
select is((select owner_id from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a201' and grantee_id = '5a000000-0000-4000-8000-0000000000b2'), '5a000000-0000-4000-8000-0000000000a1'::uuid, 'the share row carries the checked owner');

-- repeat call: changes access, created = false, no second row
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2', 'read') s), false, 'a repeat call returns created = false');
select is((select access from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a201' and grantee_id = '5a000000-0000-4000-8000-0000000000b2'), 'read', 'a repeat call changed the access');
select is((select count(*)::int from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a201' and grantee_id = '5a000000-0000-4000-8000-0000000000b2'), 1, 'a repeat call created no second row');
select is((select s.share_id from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2', 'read') s),
          (select id from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a201' and grantee_id = '5a000000-0000-4000-8000-0000000000b2'), 'a repeat call returns the existing share id');

-- update-only path (p_share_id): matching id changes the access, mismatches never create anything
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2', 'write',
            (select id from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a201' and grantee_id = '5a000000-0000-4000-8000-0000000000b2')) s), false,
  'p_share_id that matches resource and grantee changes access (created = false)');
select is((select access from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a201' and grantee_id = '5a000000-0000-4000-8000-0000000000b2'), 'write', 'p_share_id path set write');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2', 'read',
  (select id from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a201' and grantee_id = '5a000000-0000-4000-8000-0000000000c3'))$$,
  'P0001', 'not_found', 'p_share_id of another grantee row: not_found');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2', 'read',
  (select id from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a204' and grantee_id = '5a000000-0000-4000-8000-0000000000b2'))$$,
  'P0001', 'not_found', 'p_share_id of another resource row: not_found');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2', 'read',
  (select id from public.purpose_shares where purpose_id = '5a000000-0000-4000-8000-00000000a101' and grantee_id = '5a000000-0000-4000-8000-0000000000b2'))$$,
  'P0001', 'not_found', 'p_share_id of a purpose share used for a trip: not_found');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000b2', 'read', '5a000000-0000-4000-8000-0000000000ff')$$,
  'P0001', 'not_found', 'p_share_id that does not exist: not_found');
select is((select access from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a201' and grantee_id = '5a000000-0000-4000-8000-0000000000b2'), 'write', 'failed update-only calls changed nothing');

-- cap: 10 grantees per trip and per purpose, atomic in share_resource
select is((select count(*)::int from generate_series(1, 10) g,
    lateral public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a203', ('5a000000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'read') r
   where r.created), 10, 'A shares trip TA3 with 10 grantees');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a203', '5a000000-0000-4000-8000-000000000111', 'read')$$,
  'P0001', 'limit_reached', 'the 11th grantee of a trip: limit_reached');
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a203', '5a000000-0000-4000-8000-000000000101', 'write') s), false,
  'at 10 grantees a change of access still works');
select is((select count(*)::int from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a203'), 10, 'the trip still has exactly 10 share rows');
select is((select count(*)::int from generate_series(1, 10) g,
    lateral public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'purpose', '5a000000-0000-4000-8000-00000000a102', ('5a000000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'read') r
   where r.created), 10, 'A shares purpose PA2 with 10 grantees');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'purpose', '5a000000-0000-4000-8000-00000000a102', '5a000000-0000-4000-8000-000000000111', 'read')$$,
  'P0001', 'limit_reached', 'the 11th grantee of a purpose: limit_reached');
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'purpose', '5a000000-0000-4000-8000-00000000a102', '5a000000-0000-4000-8000-000000000101', 'write') s), false,
  'at 10 grantees a change of purpose access still works');

-- a grantee that left, then a stale access change: not_found, no row re-created
reset role;
set local request.jwt.claims = '{}';
do $$ begin
  perform set_config('test.gone', (select id::text from public.trip_shares
    where trip_id = '5a000000-0000-4000-8000-00000000a203' and grantee_id = '5a000000-0000-4000-8000-000000000102'), true);
end $$;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-000000000102","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.trip_shares where id = current_setting('test.gone')::uuid and grantee_id = (select auth.uid()) returning 1)
select is((select count(*)::int from d), 1, 'a grantee can leave (delete own row)');
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a203', '5a000000-0000-4000-8000-000000000102', 'write', current_setting('test.gone')::uuid)$$,
  'P0001', 'not_found', 'p_share_id of a row the grantee deleted: not_found');
select is((select count(*)::int from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a203' and grantee_id = '5a000000-0000-4000-8000-000000000102'), 0,
  'the stale access change did not re-create the grant');
reset role;
set local request.jwt.claims = '{}';
-- ---------- share rows ----------
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trip_shares where grantee_id = '5a000000-0000-4000-8000-0000000000b2'), 3, 'B sees the own incoming trip share rows');
select is((select count(*)::int from public.purpose_shares where grantee_id = '5a000000-0000-4000-8000-0000000000b2'), 1, 'B sees the own incoming purpose share row');
select is((select count(*)::int from public.trip_shares where grantee_id <> '5a000000-0000-4000-8000-0000000000b2'), 0, 'B sees no share row of other grantees');
select throws_ok($$update public.trip_shares set access = 'write' where grantee_id = '5a000000-0000-4000-8000-0000000000b2'$$, '42501', null, 'B cannot update a share row (no privilege)');
with d as (delete from public.trip_shares where grantee_id = '5a000000-0000-4000-8000-0000000000c3' returning 1)
select is((select count(*)::int from d), 0, 'B cannot delete the share row of C');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trip_shares) + (select count(*)::int from public.purpose_shares), 0, 'D sees no share rows');
with d as (delete from public.trip_shares where id is not null returning 1)
select is((select count(*)::int from d), 0, 'D cannot delete any share row');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a201'), 2, 'A sees the share rows of an own trip');
select is((select count(*)::int from public.trip_shares where owner_id <> '5a000000-0000-4000-8000-0000000000a1'), 0, 'A sees only rows it owns');
with d as (delete from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a203' and grantee_id = '5a000000-0000-4000-8000-000000000103' returning 1)
select is((select count(*)::int from d), 1, 'A can delete a share row (unshare)');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.trip_shares where trip_id = '5a000000-0000-4000-8000-00000000a204' and grantee_id = '5a000000-0000-4000-8000-0000000000c3' returning 1)
select is((select count(*)::int from d), 1, 'C can leave a trip share');
select is((select count(*)::int from public.trips where id = '5a000000-0000-4000-8000-00000000a204'), 0, 'after leaving, C no longer sees the trip');
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a204', '5a000000-0000-4000-8000-0000000000c3', 'read') s), true, 'A shares TW with C again after C left');
reset role;
set local request.jwt.claims = '{}';

-- ---------- visibility ----------
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trips where id in ('5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-00000000a204', '5a000000-0000-4000-8000-00000000a205')), 3, 'B sees the shared trips of A');
select is((select count(*)::int from public.plans where id = '5a000000-0000-4000-8000-00000000a301'), 1, 'B sees the plan of a shared trip');
select is((select count(*)::int from public.plan_versions where plan_id = '5a000000-0000-4000-8000-00000000a301'), 2, 'B sees the versions of a shared trip');
select is((select count(*)::int from public.trip_items where id = '5a000000-0000-4000-8000-00000000a501'), 1, 'B sees the items of a shared trip');
select is((select count(*)::int from public.travel_groups where id = '5a000000-0000-4000-8000-00000000a001'), 1, 'B sees the group of a shared trip');
select is((select count(*)::int from public.group_entries where group_id = '5a000000-0000-4000-8000-00000000a001'), 2, 'B sees all entries of the group of a shared trip');
select is((select count(*)::int from public.trip_purposes where id = '5a000000-0000-4000-8000-00000000a101'), 1, 'B sees the purpose of a shared trip');
select is((select count(*)::int from public.trip_purposes where id = '5a000000-0000-4000-8000-00000000a103'), 1, 'B sees a purpose that is only on a shared trip');
select is((select count(*)::int from public.trips where id in ('5a000000-0000-4000-8000-00000000a202', '5a000000-0000-4000-8000-00000000a203')), 0, 'B does not see other trips of A');
select is((select count(*)::int from public.travel_groups where id = '5a000000-0000-4000-8000-00000000a002'), 0, 'B does not see other groups of A');
select is((select count(*)::int from public.plans where id = '5a000000-0000-4000-8000-00000000a302'), 0, 'B does not see plans of other trips of A');
select is((select count(*)::int from public.trip_purposes where id in ('5a000000-0000-4000-8000-00000000a102', '5a000000-0000-4000-8000-00000000a104', '5a000000-0000-4000-8000-00000000a105')), 0, 'B does not see other purposes of A');
select is((select count(*)::int from public.share_links), 0, 'B does not see share links');
select is((select count(*)::int from public.destination_searches), 0, 'B sees no destination searches of others');
select is((select count(*)::int from public.trips where owner_id = (select auth.uid())), 1, 'B own trip list holds only B trips');
select is((select count(*)::int from public.travel_groups where owner_id = (select auth.uid())), 1, 'B own group list holds only B groups');
select is((select count(*)::int from public.trip_purposes where owner_id = (select auth.uid())), 1, 'B own purpose list holds only B purposes');
select is((select count(*)::int from public.profiles), 1, 'B still sees only the own profile');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trips where id in ('5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-00000000a204', '5a000000-0000-4000-8000-00000000a205')), 2, 'C sees the trips shared with C (TA, TW)');
select is((select count(*)::int from public.plan_versions where plan_id = '5a000000-0000-4000-8000-00000000a301'), 2, 'C sees the versions of a shared trip');
select is((select count(*)::int from public.trip_items where id = '5a000000-0000-4000-8000-00000000a501'), 1, 'C sees the items of a shared trip');
select is((select count(*)::int from public.group_entries where group_id = '5a000000-0000-4000-8000-00000000a001'), 2, 'C sees the entries of the group of a shared trip');
select is((select count(*)::int from public.trip_purposes where id = '5a000000-0000-4000-8000-00000000a101'), 1, 'C sees the shared purpose');
select is((select count(*)::int from public.trips where owner_id = (select auth.uid())), 1, 'C own trip list holds only C trips');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trips where owner_id = '5a000000-0000-4000-8000-0000000000a1'), 0, 'D sees no trip of A');
select is((select count(*)::int from public.plans where owner_id = '5a000000-0000-4000-8000-0000000000a1'), 0, 'D sees no plan of A');
select is((select count(*)::int from public.plan_versions where owner_id = '5a000000-0000-4000-8000-0000000000a1'), 0, 'D sees no version of A');
select is((select count(*)::int from public.trip_items where owner_id = '5a000000-0000-4000-8000-0000000000a1'), 0, 'D sees no item of A');
select is((select count(*)::int from public.travel_groups where owner_id = '5a000000-0000-4000-8000-0000000000a1'), 0, 'D sees no group of A');
select is((select count(*)::int from public.group_entries where owner_id = '5a000000-0000-4000-8000-0000000000a1'), 0, 'D sees no entry of A');
select is((select count(*)::int from public.trip_purposes where owner_id = '5a000000-0000-4000-8000-0000000000a1'), 0, 'D sees no purpose of A');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trips where owner_id <> '5a000000-0000-4000-8000-0000000000a1'), 0, 'A sees no trip of others');
select is((select count(*)::int from public.destination_searches where owner_id <> '5a000000-0000-4000-8000-0000000000a1'), 0, 'A sees no search of others');
reset role;
set local request.jwt.claims = '{}';

-- ---------- writes: B (write) and C (read) ----------
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
with u as (update public.trips set length_days = 9 where id = '5a000000-0000-4000-8000-00000000a201' returning 1)
select is((select count(*)::int from u), 0, 'C (read) cannot update the trip');
select throws_ok($$insert into public.plans (trip_id) values ('5a000000-0000-4000-8000-00000000a204')$$, '42501', null, 'C (read) cannot create a plan');
select throws_ok($$insert into public.plan_versions (plan_id, kind, plan, input, input_hash) values ('5a000000-0000-4000-8000-00000000a301', 'edit', '{}', '{}', repeat('c', 64))$$,
  '42501', null, 'C (read) cannot add a version');
select throws_ok($$insert into public.trip_items (trip_id, category, title) values ('5a000000-0000-4000-8000-00000000a201', 'stay', 'C hotel')$$,
  '42501', null, 'C (read) cannot add an item');
with u as (update public.trip_items set title = 'C edit' where id = '5a000000-0000-4000-8000-00000000a501' returning 1)
select is((select count(*)::int from u), 0, 'C (read) cannot update an item');
with d as (delete from public.trip_items where id = '5a000000-0000-4000-8000-00000000a501' returning 1)
select is((select count(*)::int from d), 0, 'C (read) cannot delete an item');
with u as (update public.plans set busy_until = now() + interval '5 minutes' where id = '5a000000-0000-4000-8000-00000000a301' returning 1)
select is((select count(*)::int from u), 0, 'C (read) cannot take the plan lock');
with u as (update public.plans set open_done = '{k}' where id = '5a000000-0000-4000-8000-00000000a301' returning 1)
select is((select count(*)::int from u), 0, 'C (read) cannot tick open items');
with u as (update public.trip_purposes set name = 'C edit' where id = '5a000000-0000-4000-8000-00000000a101' returning 1)
select is((select count(*)::int from u), 0, 'C (read) cannot edit the shared purpose');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
with u as (update public.trips set length_days = 9 where id = '5a000000-0000-4000-8000-00000000a201' returning 1)
select is((select count(*)::int from u), 0, 'D cannot update the trip');
select throws_ok($$insert into public.trip_items (trip_id, category, title) values ('5a000000-0000-4000-8000-00000000a201', 'stay', 'D hotel')$$,
  '42501', null, 'D cannot add an item to the trip of A (policy, not FK: the inherited owner is A)');
select throws_ok($$insert into public.plan_versions (plan_id, kind, plan, input, input_hash) values ('5a000000-0000-4000-8000-00000000a301', 'edit', '{}', '{}', repeat('d', 64))$$,
  '42501', null, 'D cannot add a version to the plan of A');
select throws_ok($$insert into public.plans (trip_id) values ('5a000000-0000-4000-8000-00000000a202')$$, '42501', null, 'D cannot create a plan for a trip of A');
reset role;

set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
with u as (update public.trips set length_days = 9 where id = '5a000000-0000-4000-8000-00000000a201' returning 1)
select is((select count(*)::int from u), 1, 'B (write) updates the trip');
select lives_ok($$insert into public.plans (trip_id) values ('5a000000-0000-4000-8000-00000000a204')$$, 'B (write) creates the plan of the shared trip');
select lives_ok($$insert into public.plan_versions (plan_id, kind, plan, input, input_hash)
  select id, 'generate', '{"v":1}', '{}', repeat('b', 64) from public.plans where trip_id = '5a000000-0000-4000-8000-00000000a204'$$, 'B (write) adds a version (inherit trigger runs before the version trigger)');
select lives_ok($$insert into public.trip_items (trip_id, category, title) values ('5a000000-0000-4000-8000-00000000a204', 'stay', 'B item')$$, 'B (write) adds an item');
select throws_ok($$insert into public.trip_items (trip_id, category, title) values ('5a000000-0000-4000-8000-00000000a202', 'stay', 'B item')$$,
  '42501', null, 'B cannot add an item to a trip that is not shared with B (42501, not 23503)');
select throws_ok($$insert into public.trip_items (trip_id, category, title) values ('5a000000-0000-4000-8000-00000000a205', 'stay', 'B item')$$,
  '42501', null, 'B (read share) cannot add an item');
with u as (update public.trip_items set title = 'B edit' where id = '5a000000-0000-4000-8000-00000000a501' returning 1)
select is((select count(*)::int from u), 1, 'B (write) updates an item');
with u as (update public.plans set busy_until = now() + interval '5 minutes' where id = '5a000000-0000-4000-8000-00000000a301' returning 1)
select is((select count(*)::int from u), 1, 'B (write) takes the plan lock');
select is((select busy_by from public.plans where id = '5a000000-0000-4000-8000-00000000a301'), '5a000000-0000-4000-8000-0000000000b2'::uuid, 'busy_by is the user who took the lock');
with u as (update public.plans set busy_until = null where id = '5a000000-0000-4000-8000-00000000a301' returning 1)
select is((select count(*)::int from u), 1, 'B (write) releases the plan lock');
select is((select busy_by from public.plans where id = '5a000000-0000-4000-8000-00000000a301'), null::uuid, 'busy_by is cleared with the lock');
with u as (update public.plans set open_done = '{k}' where id = '5a000000-0000-4000-8000-00000000a301' returning 1)
select is((select count(*)::int from u), 1, 'B (write) ticks an open item');
select throws_ok($$update public.plans set latest_version = 99 where id = '5a000000-0000-4000-8000-00000000a301'$$, '42501', null, 'B cannot write latest_version');
select throws_ok($$update public.plans set busy_by = '5a000000-0000-4000-8000-0000000000c3' where id = '5a000000-0000-4000-8000-00000000a301'$$, '42501', null, 'busy_by is not user-writable');
select throws_ok($$insert into public.plan_versions (plan_id, kind, plan, input, input_hash, created_by) values ('5a000000-0000-4000-8000-00000000a301', 'edit', '{}', '{}', repeat('b', 64), '5a000000-0000-4000-8000-0000000000c3')$$,
  '42501', null, 'created_by is not insertable');

-- owner-only columns
select throws_ok($$update public.trips set group_id = '5a000000-0000-4000-8000-00000000b001' where id = '5a000000-0000-4000-8000-00000000a201'$$, '42501', null, 'B cannot change group_id');
select throws_ok($$update public.trips set group_id = null where id = '5a000000-0000-4000-8000-00000000a201'$$, '42501', null, 'B cannot clear group_id');
select throws_ok($$update public.trips set purpose_id = '5a000000-0000-4000-8000-00000000b101' where id = '5a000000-0000-4000-8000-00000000a201'$$, '42501', null, 'B cannot change purpose_id to an own purpose');
select throws_ok($$update public.trips set purpose_id = '5a000000-0000-4000-8000-00000000a102' where id = '5a000000-0000-4000-8000-00000000a201'$$, '42501', null, 'B cannot set purpose_id (even to another purpose of the owner)');
select throws_ok($$update public.trips set purpose_id = null where id = '5a000000-0000-4000-8000-00000000a201'$$, '42501', null, 'B cannot clear purpose_id');
select throws_ok($$update public.trips set group_text = 'five friends' where id = '5a000000-0000-4000-8000-00000000a204'$$, '42501', null, 'B cannot change group_text');
select throws_ok($$update public.trips set group_text = 'five friends', group_structure = '[]'::jsonb where id = '5a000000-0000-4000-8000-00000000a204'$$, '42501', null, 'B cannot change group_structure');
select lives_ok($$update public.trips set title = 'by B', group_id = group_id, purpose_id = purpose_id where id = '5a000000-0000-4000-8000-00000000a201'$$, 'B can update trip fields while leaving the owner-only columns unchanged');

-- deletes stay owner-only
with d as (delete from public.trips where id = '5a000000-0000-4000-8000-00000000a201' returning 1)
select is((select count(*)::int from d), 0, 'B cannot delete the trip');
with d as (delete from public.plans where id = '5a000000-0000-4000-8000-00000000a301' returning 1)
select is((select count(*)::int from d), 0, 'B cannot delete the plan');
with d as (delete from public.plan_versions where plan_id = '5a000000-0000-4000-8000-00000000a301' returning 1)
select is((select count(*)::int from d), 0, 'B cannot delete plan versions');
with d as (delete from public.share_links where id = '5a000000-0000-4000-8000-00000000a601' returning 1)
select is((select count(*)::int from d), 0, 'B cannot delete share links');
with d as (delete from public.travel_groups where id = '5a000000-0000-4000-8000-00000000a001' returning 1)
select is((select count(*)::int from d), 0, 'B cannot delete the group');
with u as (update public.travel_groups set name = 'pwned' where id = '5a000000-0000-4000-8000-00000000a001' returning 1)
select is((select count(*)::int from u), 0, 'B cannot edit the group (read-only)');
with u as (update public.group_entries set name = 'pwned' where group_id = '5a000000-0000-4000-8000-00000000a001' returning 1)
select is((select count(*)::int from u), 0, 'B cannot edit group entries');
with d as (delete from public.trip_purposes where id = '5a000000-0000-4000-8000-00000000a101' returning 1)
select is((select count(*)::int from d), 0, 'B (write share) cannot delete the purpose');
select throws_ok($$insert into public.share_links (trip_id, token_hash) values ('5a000000-0000-4000-8000-00000000a201', repeat('b', 64))$$, '23503', null, 'B cannot create a share link for the trip (composite FK with B as owner)');
with d as (delete from public.trip_items where title = 'B item' returning 1)
select is((select count(*)::int from d), 1, 'B (write) deletes an item');
reset role;

-- results as seen by the owner
set local request.jwt.claims = '{}';
select is((select owner_id from public.plans where trip_id = '5a000000-0000-4000-8000-00000000a204'), '5a000000-0000-4000-8000-0000000000a1'::uuid, 'the plan B created belongs to A');
select is((select owner_id from public.plan_versions where plan_id = (select id from public.plans where trip_id = '5a000000-0000-4000-8000-00000000a204')), '5a000000-0000-4000-8000-0000000000a1'::uuid, 'the version B created belongs to A');
select is((select version_no from public.plan_versions where plan_id = (select id from public.plans where trip_id = '5a000000-0000-4000-8000-00000000a204')), 1, 'the version got version_no 1');
select is((select length_days::int from public.trips where id = '5a000000-0000-4000-8000-00000000a201'), 9, 'the trip update of B is stored');

-- created_by is the acting user
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select lives_ok($$insert into public.plan_versions (plan_id, kind, plan, input, input_hash) values ('5a000000-0000-4000-8000-00000000a301', 'edit', '{"v":3}', '{}', repeat('b', 64))$$, 'B adds a second version');
reset role;
set local request.jwt.claims = '{}';
select is((select created_by from public.plan_versions where plan_id = '5a000000-0000-4000-8000-00000000a301' and version_no = 3), '5a000000-0000-4000-8000-0000000000b2'::uuid, 'created_by is B for the version B created');
select is((select owner_id from public.plan_versions where plan_id = '5a000000-0000-4000-8000-00000000a301' and version_no = 3), '5a000000-0000-4000-8000-0000000000a1'::uuid, 'owner_id is A for the version B created');

-- the secret key (no auth.uid()) can still write group_parsed
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select lives_ok($$update public.trips set group_parsed = '{"x":1}'::jsonb where id = '5a000000-0000-4000-8000-00000000a201'$$, 'the secret key can write group_parsed');
select lives_ok($$update public.trips set group_text = 'cache path', group_id = null where id = '5a000000-0000-4000-8000-00000000a204'$$, 'the secret key passes the owner-only trigger');
-- one-off trip purpose (docs/specs/trip-purpose-text.md): the text is owner-only, the tags are written by the secret key
-- tag-only writes keep updated_at, any other change moves it (trigger trips_set_updated_at)
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, purpose_text, updated_at)
  values ('5a000000-0000-4000-8000-00000000a2f1', '5a000000-0000-4000-8000-0000000000a1', 'freetext', 'Tag clock', 2, 'Golf', '2026-01-01T00:00:00Z');
update public.trips set purpose_tags = '{"v":2}'::jsonb, purpose_tags_hash = repeat('a', 64), purpose_tags_at = now() where id = '5a000000-0000-4000-8000-00000000a2f1';
select is((select updated_at from public.trips where id = '5a000000-0000-4000-8000-00000000a2f1'), '2026-01-01T00:00:00Z'::timestamptz, 'a tag-only write does not move updated_at');
update public.trips set purpose_text = 'Golf und Strand' where id = '5a000000-0000-4000-8000-00000000a2f1';
select isnt((select updated_at from public.trips where id = '5a000000-0000-4000-8000-00000000a2f1'), '2026-01-01T00:00:00Z'::timestamptz, 'a change of the text moves updated_at');
update public.trips set updated_at = '2026-01-01T00:00:00Z' where id = '5a000000-0000-4000-8000-00000000a2f1';
select isnt((select updated_at from public.trips where id = '5a000000-0000-4000-8000-00000000a2f1'), '2026-01-01T00:00:00Z'::timestamptz, 'an update that only sets updated_at still bumps it');
select throws_ok($$update public.trips set purpose_tags = '{"v":2}'::jsonb where id = '5a000000-0000-4000-8000-00000000a204'$$, '23514', null, 'tags without a hash are rejected');
select lives_ok($$update public.trips set purpose_text = 'Golf mit einem Freund', purpose_tags = '{"v":2}'::jsonb, purpose_tags_hash = repeat('a', 64), purpose_tags_at = now() where id = '5a000000-0000-4000-8000-00000000a204'$$, 'the secret key writes purpose_text and the tags');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select throws_ok($$update public.trips set purpose_text = 'changed' where id = '5a000000-0000-4000-8000-00000000a204'$$, '42501', null, 'B (write) cannot change purpose_text');
select throws_ok($$update public.trips set purpose_text = null where id = '5a000000-0000-4000-8000-00000000a204'$$, '42501', null, 'B (write) cannot clear purpose_text');
select lives_ok($$update public.trips set title = 'by B again', purpose_text = purpose_text where id = '5a000000-0000-4000-8000-00000000a204'$$, 'B (write) can change the title while leaving purpose_text unchanged');
select is((select purpose_text from public.trips where id = '5a000000-0000-4000-8000-00000000a204'), 'Golf mit einem Freund', 'B (write) reads purpose_text');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select purpose_text from public.trips where id = '5a000000-0000-4000-8000-00000000a204'), 'Golf mit einem Freund', 'C (read) reads purpose_text');
select throws_ok($$update public.trips set purpose_tags_hash = repeat('b', 64) where id = '5a000000-0000-4000-8000-00000000a204'$$, '42501', null, 'C cannot write purpose_tags_hash (no column grant)');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trips where purpose_text is not null), 0, 'D (stranger) reads no trip with a purpose_text');
reset role;
set local request.jwt.claims = '{}';

-- ---------- prune_plan_versions ----------
insert into public.plan_versions (plan_id, kind, plan, input, input_hash)
select '5a000000-0000-4000-8000-00000000a301', 'edit', '{"v":9}', '{}', repeat('a', 64) from generate_series(1, 33);
select is((select latest_version from public.plans where id = '5a000000-0000-4000-8000-00000000a301'), 36, 'plan has 36 versions before pruning');
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select public.prune_plan_versions('5a000000-0000-4000-8000-00000000a301')$$, '42501', null, 'C (read) cannot prune');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select public.prune_plan_versions('5a000000-0000-4000-8000-00000000a301')$$, '42501', null, 'D cannot prune');
select throws_ok($$select public.prune_plan_versions('5a000000-0000-4000-8000-0000000000ff')$$, '42501', null, 'pruning an unknown plan is refused');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select lives_ok($$select public.prune_plan_versions('5a000000-0000-4000-8000-00000000a301')$$, 'B (write) prunes');
select lives_ok($$select public.prune_plan_versions((select id from public.plans where trip_id = '5a000000-0000-4000-8000-00000000a204'))$$, 'pruning a short history deletes nothing and does not fail');
select is((select count(*)::int from public.plan_versions where plan_id = '5a000000-0000-4000-8000-00000000a301'), 30, 'only the last 30 versions are kept');
select is((select min(version_no) from public.plan_versions where plan_id = '5a000000-0000-4000-8000-00000000a301'), 7, 'versions up to latest - 30 are gone');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select lives_ok($$select public.prune_plan_versions('5a000000-0000-4000-8000-00000000a301')$$, 'the owner can prune');
reset role;
set local request.jwt.claims = '{}';
-- ---------- purposes ----------
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
with u as (update public.trip_purposes set name = 'A golf (B)', text = 'edited by B' where id = '5a000000-0000-4000-8000-00000000a101' returning 1)
select is((select count(*)::int from u), 1, 'B (write share) edits name and text of the shared purpose');
select throws_ok($$update public.trip_purposes set parsed_tags = '{}' where id = '5a000000-0000-4000-8000-00000000a101'$$, '42501', null, 'B cannot write parsed_tags');
with u as (update public.trip_purposes set name = 'pwned' where id = '5a000000-0000-4000-8000-00000000a103' returning 1)
select is((select count(*)::int from u), 0, 'B cannot edit a purpose that is only on a shared trip');
select lives_ok($$insert into public.trips (dest_kind, dest_name, length_days, purpose_id) values ('freetext', 'B uses PA', 2, '5a000000-0000-4000-8000-00000000a101')$$,
  'B attaches the shared purpose to an own trip');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, purpose_id) values ('freetext', 'B uses PX', 2, '5a000000-0000-4000-8000-00000000a103')$$,
  '23503', null, 'B cannot attach a purpose seen only through a shared trip');
select throws_ok($$update public.trips set purpose_id = '5a000000-0000-4000-8000-00000000a103' where id = '5a000000-0000-4000-8000-00000000b201'$$, '23503', null, 'B cannot re-point an own trip to a purpose seen only through a shared trip');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, purpose_id) values ('freetext', 'B uses PA2', 2, '5a000000-0000-4000-8000-00000000a102')$$,
  '23503', null, 'B cannot attach a purpose of A that is not shared with B');
select lives_ok($$update public.trips set purpose_id = '5a000000-0000-4000-8000-00000000a101' where id = '5a000000-0000-4000-8000-00000000b201'$$, 'B can re-point an own trip to the shared purpose');
select lives_ok($$update public.trips set purpose_id = '5a000000-0000-4000-8000-00000000b101' where id = '5a000000-0000-4000-8000-00000000b201'$$, 'B can re-point it back to an own purpose');
select lives_ok($$insert into public.destination_searches (purpose_id, purpose_name, locale, input_hash, input, status, cards)
  values ('5a000000-0000-4000-8000-00000000a101', 'A golf', 'en', repeat('b', 64), '{"v":1}', 'done', '[{"place":"x"}]')$$, 'B runs a destination search with the shared purpose');
select throws_ok($$insert into public.destination_searches (purpose_id, purpose_name, locale, input_hash, input, status)
  values ('5a000000-0000-4000-8000-00000000a103', 'x', 'en', repeat('c', 64), '{}', 'done')$$, '23503', null, 'B cannot search with a purpose seen only through a shared trip');
select throws_ok($$insert into public.destination_searches (purpose_id, purpose_name, locale, input_hash, input, status)
  values ('5a000000-0000-4000-8000-00000000a102', 'x', 'en', repeat('d', 64), '{}', 'done')$$, '23503', null, 'B cannot search with a purpose of A that is not shared with B');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select lives_ok($$insert into public.trips (dest_kind, dest_name, length_days, purpose_id) values ('freetext', 'C uses PA', 2, '5a000000-0000-4000-8000-00000000a101')$$,
  'C (read share) attaches the shared purpose to an own trip');
select lives_ok($$insert into public.trips (dest_kind, dest_name, length_days, purpose_id) values ('freetext', 'C uses PD', 2, '5a000000-0000-4000-8000-00000000a104')$$,
  'C attaches PD to an own trip');
select lives_ok($$insert into public.trips (dest_kind, dest_name, length_days, purpose_id) values ('freetext', 'C uses PE', 2, '5a000000-0000-4000-8000-00000000a105')$$,
  'C attaches PE to an own trip');
select lives_ok($$insert into public.destination_searches (purpose_id, purpose_name, locale, input_hash, input, status, cards)
  values ('5a000000-0000-4000-8000-00000000a101', 'A golf', 'en', repeat('e', 64), '{"v":1}', 'done', '[{"place":"y"}]')$$, 'C (read share) runs a destination search with the shared purpose');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, purpose_id) values ('freetext', 'D uses PA', 2, '5a000000-0000-4000-8000-00000000a101')$$,
  '23503', null, 'D cannot attach the purpose of A (not shared)');
select throws_ok($$insert into public.destination_searches (purpose_id, purpose_name, locale, input_hash, input, status)
  values ('5a000000-0000-4000-8000-00000000a101', 'x', 'en', repeat('f', 64), '{}', 'done')$$, '23503', null, 'D cannot search with the purpose of A');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.destination_searches where owner_id <> '5a000000-0000-4000-8000-0000000000a1'), 0, 'A sees none of the searches of B and C');
-- owner unshares B: B's trip and search lose the reference, the search keeps label and cards
with d as (delete from public.purpose_shares where purpose_id = '5a000000-0000-4000-8000-00000000a101' and grantee_id = '5a000000-0000-4000-8000-0000000000b2' returning 1)
select is((select count(*)::int from d), 1, 'A unshares the purpose from B');
reset role;
set local request.jwt.claims = '{}';
select is((select purpose_id from public.trips where owner_id = '5a000000-0000-4000-8000-0000000000b2' and dest_name = 'B uses PA'), null::uuid, 'after unshare, the trip of B has no purpose');
select is((select purpose_id from public.destination_searches where owner_id = '5a000000-0000-4000-8000-0000000000b2'), null::uuid, 'after unshare, the search of B has no purpose');
select is((select purpose_name from public.destination_searches where owner_id = '5a000000-0000-4000-8000-0000000000b2'), 'A golf', 'the search of B keeps its purpose_name');
select is((select jsonb_array_length(cards) from public.destination_searches where owner_id = '5a000000-0000-4000-8000-0000000000b2'), 1, 'the search of B keeps its cards');
select is((select purpose_id from public.trips where id = '5a000000-0000-4000-8000-00000000b201'), '5a000000-0000-4000-8000-00000000b101'::uuid, 'the own purpose of B is untouched');
select is((select purpose_id from public.trips where owner_id = '5a000000-0000-4000-8000-0000000000c3' and dest_name = 'C uses PA'), '5a000000-0000-4000-8000-00000000a101'::uuid, 'the reference of C is untouched by the unshare from B');
-- grantee leaves: C's references are cleared too
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.purpose_shares where purpose_id = '5a000000-0000-4000-8000-00000000a101' and grantee_id = (select auth.uid()) returning 1)
select is((select count(*)::int from d), 1, 'C leaves the purpose share');
reset role;
set local request.jwt.claims = '{}';
select is((select purpose_id from public.trips where owner_id = '5a000000-0000-4000-8000-0000000000c3' and dest_name = 'C uses PA'), null::uuid, 'after leaving, the trip of C has no purpose');
select is((select purpose_id from public.destination_searches where owner_id = '5a000000-0000-4000-8000-0000000000c3'), null::uuid, 'after leaving, the search of C has no purpose');
select is((select purpose_name from public.destination_searches where owner_id = '5a000000-0000-4000-8000-0000000000c3'), 'A golf', 'the search of C keeps its purpose_name');
select is((select count(*)::int from public.trips where id = '5a000000-0000-4000-8000-00000000a201' and purpose_id = '5a000000-0000-4000-8000-00000000a101'), 1, 'the purpose of the own trip of A is untouched');
-- owner deletes the purpose: the recipient trip loses the reference (foreign key action, owner-only trigger lets it pass)
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.trip_purposes where id = '5a000000-0000-4000-8000-00000000a104' returning 1)
select is((select count(*)::int from d), 1, 'A deletes a purpose that C uses');
reset role;
set local request.jwt.claims = '{}';
select is((select purpose_id from public.trips where owner_id = '5a000000-0000-4000-8000-0000000000c3' and dest_name = 'C uses PD'), null::uuid, 'deleting the purpose clears the reference on the trip of C');
select is((select count(*)::int from public.purpose_shares where purpose_id = '5a000000-0000-4000-8000-00000000a104'), 0, 'deleting the purpose removed its shares');

-- ---------- disabled owner (F) ----------
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000f6', 'trip', '5a000000-0000-4000-8000-00000000f201', '5a000000-0000-4000-8000-0000000000b2', 'read') s), true, 'F shares trip TF with B');
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000f6', 'purpose', '5a000000-0000-4000-8000-00000000f101', '5a000000-0000-4000-8000-0000000000b2', 'read') s), true, 'F shares purpose PF with B');
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000f6', 'purpose', '5a000000-0000-4000-8000-00000000f101', '5a000000-0000-4000-8000-0000000000a1', 'read') s), true, 'F shares purpose PF with A');
reset role;
set local request.jwt.claims = '{}';
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, purpose_id)
  values ('5a000000-0000-4000-8000-00000000a206', '5a000000-0000-4000-8000-0000000000a1', 'freetext', 'A trip with the purpose of F', 3, '5a000000-0000-4000-8000-00000000f101');
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select s.created from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a206', '5a000000-0000-4000-8000-0000000000c3', 'read') s), true, 'A shares trip TAF (purpose of F) with C');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trips where id = '5a000000-0000-4000-8000-00000000f201'), 1, 'F active: B sees the trip of F');
select is((select count(*)::int from public.plans where id = '5a000000-0000-4000-8000-00000000f301'), 1, 'F active: B sees the plan of F');
select is((select count(*)::int from public.plan_versions where plan_id = '5a000000-0000-4000-8000-00000000f301'), 1, 'F active: B sees the versions of F');
select is((select count(*)::int from public.trip_items where id = '5a000000-0000-4000-8000-00000000f501'), 1, 'F active: B sees the items of F');
select is((select count(*)::int from public.travel_groups where id = '5a000000-0000-4000-8000-00000000f001'), 1, 'F active: B sees the group of F');
select is((select count(*)::int from public.group_entries where group_id = '5a000000-0000-4000-8000-00000000f001'), 1, 'F active: B sees the entries of F');
select is((select count(*)::int from public.trip_purposes where id = '5a000000-0000-4000-8000-00000000f101'), 1, 'F active: B sees the purpose of F');
select is((select count(*)::int from public.trip_shares where owner_id = '5a000000-0000-4000-8000-0000000000f6') + (select count(*)::int from public.purpose_shares where owner_id = '5a000000-0000-4000-8000-0000000000f6'), 2, 'F active: B sees the share rows of F');
select is((select count(*)::int from public.share_contacts() where user_id = '5a000000-0000-4000-8000-0000000000f6'), 1, 'F active: share_contacts of B includes F');
select is((select count(*)::int from public.share_contacts() where user_id in ('5a000000-0000-4000-8000-0000000000c3', '5a000000-0000-4000-8000-0000000000d4')), 0, 'share_contacts of B holds only counterparts (no C, no D)');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trip_purposes where id = '5a000000-0000-4000-8000-00000000f101'), 1, 'F active: C sees the purpose of F through the shared trip TAF');
reset role;
set local request.jwt.claims = '{}';
select is(private.purpose_usable_by('5a000000-0000-4000-8000-00000000f101', '5a000000-0000-4000-8000-0000000000b2'), true, 'F active: the purpose of F is usable by B');
select is(private.purpose_usable_by('5a000000-0000-4000-8000-00000000a103', '5a000000-0000-4000-8000-0000000000b2'), false, 'a purpose seen only through a shared trip is not usable');
select is(private.purpose_usable_by('5a000000-0000-4000-8000-00000000b101', '5a000000-0000-4000-8000-0000000000b2'), true, 'an own purpose is usable');
select is(private.purpose_usable_by('5a000000-0000-4000-8000-00000000b101', '5a000000-0000-4000-8000-0000000000a1'), false, 'the purpose of B is not usable by A');

update public.profiles set disabled_at = now() where id = '5a000000-0000-4000-8000-0000000000f6';

set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trip_shares where owner_id = '5a000000-0000-4000-8000-0000000000f6') + (select count(*)::int from public.purpose_shares where owner_id = '5a000000-0000-4000-8000-0000000000f6'), 0, 'F disabled: B no longer sees the share rows of F');
select is((select count(*)::int from public.trips where id = '5a000000-0000-4000-8000-00000000f201'), 0, 'F disabled: B no longer sees the trip of F');
select is((select count(*)::int from public.plans where id = '5a000000-0000-4000-8000-00000000f301'), 0, 'F disabled: no plan of F');
select is((select count(*)::int from public.plan_versions where plan_id = '5a000000-0000-4000-8000-00000000f301'), 0, 'F disabled: no versions of F');
select is((select count(*)::int from public.trip_items where id = '5a000000-0000-4000-8000-00000000f501'), 0, 'F disabled: no items of F');
select is((select count(*)::int from public.travel_groups where id = '5a000000-0000-4000-8000-00000000f001'), 0, 'F disabled: no group of F');
select is((select count(*)::int from public.group_entries where group_id = '5a000000-0000-4000-8000-00000000f001'), 0, 'F disabled: no entries of F');
select is((select count(*)::int from public.trip_purposes where id = '5a000000-0000-4000-8000-00000000f101'), 0, 'F disabled: no purpose of F');
select is((select count(*)::int from public.share_contacts() where user_id = '5a000000-0000-4000-8000-0000000000f6'), 0, 'F disabled: share_contacts of B does not return F');
select is((select count(*)::int from public.share_contacts() where user_id = '5a000000-0000-4000-8000-0000000000a1'), 1, 'F disabled: share_contacts of B still returns A');
select is((select count(*)::int from public.trips where id = '5a000000-0000-4000-8000-00000000a201'), 1, 'F disabled: the trips of other owners stay visible');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trips where id = '5a000000-0000-4000-8000-00000000a206'), 1, 'F disabled: C still sees the trip TAF of A');
select is((select count(*)::int from public.trip_purposes where id = '5a000000-0000-4000-8000-00000000f101'), 0, 'F disabled: the purpose of F is not visible through the trip of A');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000f6","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.share_contacts() where user_id in ('5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-0000000000b2')), 2, 'F disabled: the own grantees list of F still returns A and B');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trip_purposes where id = '5a000000-0000-4000-8000-00000000f101'), 0, 'F disabled: A no longer sees the purpose of F');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, purpose_id) values ('freetext', 'new with PF', 2, '5a000000-0000-4000-8000-00000000f101')$$,
  '23503', null, 'F disabled: a new trip cannot use the purpose of F');
select throws_ok($$insert into public.destination_searches (purpose_id, purpose_name, locale, input_hash, input, status)
  values ('5a000000-0000-4000-8000-00000000f101', 'F ski', 'en', repeat('9', 64), '{}', 'done')$$, '23503', null, 'F disabled: a search cannot use the purpose of F');
select lives_ok($$update public.trips set title = 'still editable', purpose_id = '5a000000-0000-4000-8000-00000000f101' where id = '5a000000-0000-4000-8000-00000000a206'$$, 'F disabled: an unchanged purpose reference does not block editing the trip');
reset role;
set local request.jwt.claims = '{}';
select is(private.purpose_usable_by('5a000000-0000-4000-8000-00000000f101', '5a000000-0000-4000-8000-0000000000b2'), false, 'F disabled: the purpose of F is not usable by B');
select is(private.is_active('5a000000-0000-4000-8000-0000000000f6'), false, 'is_active is false for the disabled F');
select is(private.is_active('5a000000-0000-4000-8000-0000000000ff'), false, 'is_active is false for an unknown id');
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000f6', 'purpose', '5a000000-0000-4000-8000-00000000f101', '5a000000-0000-4000-8000-0000000000c3', 'read')$$, 'P0001', 'forbidden', 'F disabled: F as owner is forbidden');
select throws_ok($$select * from public.share_resource('5a000000-0000-4000-8000-0000000000a1', 'trip', '5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-0000000000f6', 'read')$$, 'P0001', 'no_account', 'F disabled: F as grantee is no_account');
select is((select public.share_user_by_email('f@share.test')), null::uuid, 'share_user_by_email returns null for a disabled account');
reset role;
set local request.jwt.claims = '{}';
update public.profiles set disabled_at = null where id = '5a000000-0000-4000-8000-0000000000f6';
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trips where id = '5a000000-0000-4000-8000-00000000f201'), 1, 'F re-enabled: B sees the trip of F again');
select is((select count(*)::int from public.trip_purposes where id = '5a000000-0000-4000-8000-00000000f101'), 1, 'F re-enabled: B sees the purpose of F again');
select is((select count(*)::int from public.trip_shares where owner_id = '5a000000-0000-4000-8000-0000000000f6') + (select count(*)::int from public.purpose_shares where owner_id = '5a000000-0000-4000-8000-0000000000f6'), 2, 'F re-enabled: the share rows are back');
select is((select count(*)::int from public.share_contacts() where user_id = '5a000000-0000-4000-8000-0000000000f6'), 1, 'F re-enabled: share_contacts returns F again');
reset role;
set local request.jwt.claims = '{}';

-- ---------- lookups ----------
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select public.share_user_by_email('a@share.test')), '5a000000-0000-4000-8000-0000000000a1'::uuid, 'share_user_by_email finds an account');
select is((select public.share_user_by_email('  ')), null::uuid, 'share_user_by_email: blank is unknown');
select is((select public.share_user_by_email('A@SHARE.test')), '5a000000-0000-4000-8000-0000000000a1'::uuid, 'share_user_by_email ignores case');
select is((select public.share_user_by_email('e@share.test')), null::uuid, 'share_user_by_email returns null for the demo account');
select is((select public.share_user_by_email('nobody@share.test')), null::uuid, 'share_user_by_email returns null for an unknown email');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select public.share_user_by_email('b@share.test')$$, '42501', null, 'authenticated cannot call share_user_by_email');
select is((select count(*)::int from public.share_contacts() where user_id = '5a000000-0000-4000-8000-0000000000d4'), 0, 'share_contacts of A does not return the stranger D');
select ok((select count(*)::int from public.share_contacts() where user_id in ('5a000000-0000-4000-8000-0000000000b2', '5a000000-0000-4000-8000-0000000000c3', '5a000000-0000-4000-8000-0000000000f6')) = 3, 'share_contacts of A returns the counterparts B, C and F');
select is((select email from public.share_contacts() where user_id = '5a000000-0000-4000-8000-0000000000b2'), 'b@share.test', 'share_contacts returns the email');
select is((select display_name from public.share_contacts() where user_id = '5a000000-0000-4000-8000-0000000000b2'), 'Bob', 'share_contacts returns the display name');
reset role;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.share_contacts()), 0, 'share_contacts of D is empty');
reset role;
set local role anon;
select throws_ok($$select * from public.share_contacts()$$, '42501', null, 'anon cannot call share_contacts');
reset role;
set local request.jwt.claims = '{}';

-- ---------- admin aggregate ----------
insert into public.app_events (event, props) values ('sharing.lookup', '{"found":true}'), ('sharing.lookup', '{"found":false}'), ('sharing.granted', '{}');
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select (public.admin_share_stats(now() - interval '1 day') ->> 'lookupsThisMonth')::int), 2, 'admin_share_stats counts lookups');
select is((select (public.admin_share_stats(now() - interval '1 day') ->> 'lookupMissesThisMonth')::int), 1, 'admin_share_stats counts lookup misses');
select is((select (public.admin_share_stats(now() - interval '1 day') ->> 'tripSharesWrite')::int), (select count(*)::int from public.trip_shares where access = 'write'), 'admin_share_stats counts write trip shares');
select is((select (public.admin_share_stats(now() - interval '1 day') ->> 'recipients')::int),
  (select count(distinct g)::int from (select grantee_id g from public.trip_shares union all select grantee_id from public.purpose_shares union all select grantee_id from public.group_shares) x), 'admin_share_stats counts distinct recipients');
select is((select (select count(*) from jsonb_object_keys(public.admin_share_stats(now() - interval '1 day')))::int), 13, 'admin_share_stats returns thirteen counters and nothing else');
select is((select (public.admin_share_stats(now() + interval '1 day') ->> 'grantsThisMonth')::int), 0, 'admin_share_stats: grants before the month start are not counted');
reset role;
set local request.jwt.claims = '{}';

-- ---------- cascades ----------
-- B holds a lock and created a version, then B is deleted: both references become null, the plan and version stay.
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select lives_ok($$update public.plans set busy_until = now() + interval '5 minutes' where id = '5a000000-0000-4000-8000-00000000a301'$$, 'B takes the plan lock before deletion');
reset role;
set local request.jwt.claims = '{}';
select is((select busy_by from public.plans where id = '5a000000-0000-4000-8000-00000000a301'), '5a000000-0000-4000-8000-0000000000b2'::uuid, 'busy_by is B');
delete from auth.users where id = '5a000000-0000-4000-8000-0000000000b2';
select is((select busy_by from public.plans where id = '5a000000-0000-4000-8000-00000000a301'), null::uuid, 'deleting B nulls plans.busy_by');
select is((select count(*)::int from public.plan_versions where plan_id = '5a000000-0000-4000-8000-00000000a301' and version_no = 3), 0, 'version 3 was pruned earlier (history beyond 30 is gone)');
select is((select count(*)::int from public.plan_versions where plan_id = (select id from public.plans where trip_id = '5a000000-0000-4000-8000-00000000a204') and created_by is null), 1, 'deleting B nulls plan_versions.created_by, the version stays with the owner');
select is((select count(*)::int from public.trip_shares where grantee_id = '5a000000-0000-4000-8000-0000000000b2') + (select count(*)::int from public.purpose_shares where grantee_id = '5a000000-0000-4000-8000-0000000000b2'), 0, 'deleting B removed the shares B received');
-- A is deleted: all shares of A go, and the recipient keeps own rows with the purpose reference cleared
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, purpose_id)
  values ('5a000000-0000-4000-8000-00000000c202', '5a000000-0000-4000-8000-0000000000c3', 'freetext', 'C trip on a purpose of A', 2, '5a000000-0000-4000-8000-00000000a105');
select is((select count(*)::int from public.trip_shares where owner_id = '5a000000-0000-4000-8000-0000000000a1') > 0, true, 'A still has trip shares before deletion');
delete from auth.users where id = '5a000000-0000-4000-8000-0000000000a1';
select is((select count(*)::int from public.trip_shares where owner_id = '5a000000-0000-4000-8000-0000000000a1') + (select count(*)::int from public.purpose_shares where owner_id = '5a000000-0000-4000-8000-0000000000a1'), 0, 'deleting A removed every share of A');
select is((select count(*)::int from public.trip_shares where trip_id in ('5a000000-0000-4000-8000-00000000a201', '5a000000-0000-4000-8000-00000000a204', '5a000000-0000-4000-8000-00000000a203')), 0, 'no share row is left for the trips of A');
select is((select purpose_id from public.trips where id = '5a000000-0000-4000-8000-00000000c202'), null::uuid, 'the trip of C survives A with the purpose reference cleared');
select is((select count(*)::int from public.trips where owner_id = '5a000000-0000-4000-8000-0000000000c3'), 5, 'the own trips of C survive the deletion of A');
select is((select count(*)::int from public.purpose_shares where grantee_id = '5a000000-0000-4000-8000-0000000000a1'), 0, 'a share to A (purpose of F) was removed with A');

select * from finish();
rollback;
