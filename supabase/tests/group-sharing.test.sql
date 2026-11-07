-- pgTAP tests for sharing travel groups (migration 20261112120037, docs/specs/group-sharing.md sections 2 and 5).
-- Run with `supabase test db`. One transaction, rolled back. now() is constant inside it, so "moved updated_at" checks
-- insert the row with an old updated_at first.
-- Actors: A group owner, B write grantee, C read grantee, D stranger, E demo, F owner who gets disabled, T recipient of
-- a trip of A that uses A's group (trip only), R recipient of a trip of B that uses A's group (trip only),
-- G01..G11 extra users (cap and account-deletion tests). Share rows are created with public.share_resource as
-- service_role, the only write path. Concurrency cases live in sharing-concurrency.sh.
-- Convention: `reset role; set local request.jwt.claims = '{}'` before a postgres section (auth.uid() = null),
-- `set local request.jwt.claims = '{"sub":...}'; set local role authenticated` to act as a user.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select * from no_plan();

-- ---------- fixtures (as postgres) ----------
insert into public.signup_allowlist (email) values
  ('a@gshare.test'), ('b@gshare.test'), ('c@gshare.test'), ('d@gshare.test'), ('e@gshare.test'), ('f@gshare.test'),
  ('t@gshare.test'), ('r@gshare.test');
insert into public.signup_allowlist (email) select 'g' || g || '@gshare.test' from generate_series(1, 11) g;
insert into auth.users (id, email, raw_user_meta_data, aud, role) values
  ('6a000000-0000-4000-8000-0000000000a1', 'a@gshare.test', '{}', 'authenticated', 'authenticated'),
  ('6a000000-0000-4000-8000-0000000000b2', 'b@gshare.test', '{}', 'authenticated', 'authenticated'),
  ('6a000000-0000-4000-8000-0000000000c3', 'c@gshare.test', '{}', 'authenticated', 'authenticated'),
  ('6a000000-0000-4000-8000-0000000000d4', 'd@gshare.test', '{}', 'authenticated', 'authenticated'),
  ('6a000000-0000-4000-8000-0000000000e5', 'e@gshare.test', '{}', 'authenticated', 'authenticated'),
  ('6a000000-0000-4000-8000-0000000000f6', 'f@gshare.test', '{}', 'authenticated', 'authenticated'),
  ('6a000000-0000-4000-8000-000000000071', 't@gshare.test', '{}', 'authenticated', 'authenticated'),
  ('6a000000-0000-4000-8000-000000000072', 'r@gshare.test', '{}', 'authenticated', 'authenticated');
insert into auth.users (id, email, raw_user_meta_data, aud, role)
select ('6a000000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'g' || g || '@gshare.test', '{}', 'authenticated', 'authenticated'
  from generate_series(1, 11) g;
update public.profiles set is_demo = true where id = '6a000000-0000-4000-8000-0000000000e5';
update public.profiles set display_name = 'Alice' where id = '6a000000-0000-4000-8000-0000000000a1';
update public.profiles set display_name = 'Bob' where id = '6a000000-0000-4000-8000-0000000000b2';
update public.profiles set display_name = 'Cara' where id = '6a000000-0000-4000-8000-0000000000c3';
update public.profiles set display_name = 'Rae' where id = '6a000000-0000-4000-8000-000000000072';

insert into public.travel_groups (id, owner_id, name) values
  ('6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000a1', 'A family'), ('6a000000-0000-4000-8000-00000000a002', '6a000000-0000-4000-8000-0000000000a1', 'A other'), ('6a000000-0000-4000-8000-00000000a003', '6a000000-0000-4000-8000-0000000000a1', 'A cap'), ('6a000000-0000-4000-8000-00000000a004', '6a000000-0000-4000-8000-0000000000a1', 'A to delete'),
  ('6a000000-0000-4000-8000-00000000b001', '6a000000-0000-4000-8000-0000000000b2', 'B group'), ('6a000000-0000-4000-8000-00000000f001', '6a000000-0000-4000-8000-0000000000f6', 'F group');
insert into public.group_entries (id, group_id, owner_id, kind, name, is_self, count, label, "position") values
  ('6a000000-0000-4000-8000-00000000e001', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000a1', 'composition', null,  false, 2, null,    0),
  ('6a000000-0000-4000-8000-00000000e002', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000a1', 'member',      null,  true,  1, 'Alice', 1),
  ('6a000000-0000-4000-8000-00000000e003', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000a1', 'member',      'Ben', false, 1, null,    2),
  ('6a000000-0000-4000-8000-00000000e004', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000a1', 'member',      'Cy',  false, 1, null,    3),
  ('6a000000-0000-4000-8000-00000000e005', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000a1', 'member',      'Cara', false, 1, null,   4),
  ('6a000000-0000-4000-8000-00000000e006', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000a1', 'member',      'Bye', false, 1, null,    5),
  ('6a000000-0000-4000-8000-00000000e007', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000a1', 'member',      'Dee', false, 1, null,    6),
  ('6a000000-0000-4000-8000-00000000e008', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000a1', 'member',      'Gus', false, 1, null,    7),
  ('6a000000-0000-4000-8000-00000000e101', '6a000000-0000-4000-8000-00000000a002', '6a000000-0000-4000-8000-0000000000a1', 'member',   'Ola', false, 1, null,    0),
  ('6a000000-0000-4000-8000-00000000eb01', '6a000000-0000-4000-8000-00000000b001', '6a000000-0000-4000-8000-0000000000b2', 'member',     'Bea', false, 1, null,    0),
  ('6a000000-0000-4000-8000-00000000ef01', '6a000000-0000-4000-8000-00000000f001', '6a000000-0000-4000-8000-0000000000f6', 'member',     'Fay', false, 1, null,    0);
-- old updated_at: nothing may touch these rows before the tests that watch them
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, group_id, updated_at) values
  ('6a000000-0000-4000-8000-00000000a201', '6a000000-0000-4000-8000-0000000000a1', 'freetext', 'A trip', 3, '6a000000-0000-4000-8000-00000000a001', '2020-01-01 00:00+00');
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days) values
  ('6a000000-0000-4000-8000-00000000d201', '6a000000-0000-4000-8000-0000000000d4', 'freetext', 'D trip', 3), ('6a000000-0000-4000-8000-00000000e201', '6a000000-0000-4000-8000-000000000071', 'freetext', 'T trip', 3), ('6a000000-0000-4000-8000-00000000e202', '6a000000-0000-4000-8000-000000000072', 'freetext', 'R trip', 3);

-- ---------- structure ----------
select ok((select relrowsecurity from pg_class where oid = 'public.group_shares'::regclass), 'RLS enabled on group_shares');
select is((select count(*)::int from pg_constraint c
   where c.conrelid in ('public.trips'::regclass, 'public.destination_searches'::regclass)
     and c.contype = 'f' and c.confrelid = 'public.travel_groups'::regclass and cardinality(c.conkey) = 2), 0,
  'no composite group FK left on trips and destination_searches');
select is((select count(*)::int from pg_constraint c
   where c.conrelid in ('public.trips'::regclass, 'public.destination_searches'::regclass)
     and c.contype = 'f' and c.confrelid = 'public.travel_groups'::regclass and cardinality(c.conkey) = 1
     and c.confdeltype = 'n'), 2, 'plain group FK with on delete set null on trips and destination_searches');
select is((select array_agg(t.tgname::text order by t.tgname) from pg_trigger t
   where t.tgrelid = 'public.group_entries'::regclass and not t.tgisinternal and (t.tgtype & 6) = 6),
  array['group_entries_00_inherit_owner', 'group_entries_01_guard'],
  'group_entries: inherit-owner trigger fires before the guard (name order)');
select ok((select array_position(array_agg(t.tgname::text order by t.tgname), 'trips_00_owner_only')
            < array_position(array_agg(t.tgname::text order by t.tgname), 'trips_check_group_ref')
             from pg_trigger t where t.tgrelid = 'public.trips'::regclass and not t.tgisinternal and (t.tgtype & 18) = 18),
  'trips: trips_00_owner_only fires before trips_check_group_ref (name order)');
select ok(exists (select 1 from pg_trigger t where t.tgrelid = 'public.group_shares'::regclass and t.tgname = 'group_shares_removed' and not t.tgisinternal),
  'group_shares_removed trigger exists');
select ok(exists (select 1 from pg_trigger t where t.tgrelid = 'public.trip_shares'::regclass and t.tgname = 'trip_shares_prune_links' and not t.tgisinternal),
  'trip_shares_prune_links trigger exists');
select ok(exists (select 1 from pg_trigger t where t.tgrelid = 'public.trips'::regclass and t.tgname = 'trips_group_changed' and not t.tgisinternal),
  'trips_group_changed trigger exists');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and p.proname in ('shared_group_ids', 'writable_group_ids', 'group_usable_by',
              'group_reachable', 'inherit_group_owner', 'check_group_ref', 'group_share_removed', 'prune_group_links',
              'trip_share_removed_prune', 'trip_group_changed_prune')),
  'group helper and trigger functions are security definer with an empty search_path');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'replace_group_entries'), 1, 'exactly one replace_group_entries (the old signature is gone)');

-- ---------- no group shares yet: the widened policies add nothing ----------
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where owner_id <> (select auth.uid())), 0, 'no group shares: B sees only own groups');
select is((select count(*)::int from public.group_entries where owner_id <> (select auth.uid())), 0, 'no group shares: B sees only own entries');
select is((select count(*)::int from public.group_shares), 0, 'no group shares: B sees no share rows');
select is((select private.shared_group_ids()), '{}'::uuid[], 'no group shares: B shared_group_ids is empty');
select is((select private.writable_group_ids()), '{}'::uuid[], 'no group shares: B writable_group_ids is empty');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where owner_id <> (select auth.uid())), 0, 'no group shares: C sees only own groups');
select is((select count(*)::int from public.group_entries where owner_id <> (select auth.uid())), 0, 'no group shares: C sees only own entries');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where owner_id <> (select auth.uid())), 0, 'no group shares: D sees only own groups');
select is((select count(*)::int from public.group_entries where owner_id <> (select auth.uid())), 0, 'no group shares: D sees only own entries');
select throws_ok($$select public.claim_group_entry('6a000000-0000-4000-8000-00000000e003')$$, 'P0001', 'not_found', 'D claims an entry of an unshared group: not_found');
select throws_ok($$select * from public.unclaim_group_entry('6a000000-0000-4000-8000-00000000e003')$$, 'P0001', 'not_found', 'D unclaims an entry of an unshared group: not_found');
select throws_ok($$select public.claim_group_entry(null)$$, 'P0001', 'forbidden', 'a null entry id: forbidden');
select throws_ok($$select public.claim_group_entry('6a000000-0000-4000-8000-0000000000ff')$$, 'P0001', 'not_found', 'an unknown entry id: not_found');
reset role;
set local request.jwt.claims = '{}';

-- ---------- privileges: clients cannot create or change a group share ----------
select ok(not has_table_privilege('authenticated', 'public.group_shares', 'insert'), 'authenticated: no insert on group_shares');
select ok(not has_table_privilege('authenticated', 'public.group_shares', 'update'), 'authenticated: no update on group_shares');
select ok(not has_any_column_privilege('authenticated', 'public.group_shares', 'insert'), 'authenticated: no column insert on group_shares');
select ok(not has_any_column_privilege('authenticated', 'public.group_shares', 'update'), 'authenticated: no column update on group_shares');
select ok(has_table_privilege('authenticated', 'public.group_shares', 'select') and has_table_privilege('authenticated', 'public.group_shares', 'delete'), 'authenticated: select and delete on group_shares');
select ok(not has_table_privilege('anon', 'public.group_shares', 'select'), 'anon: no select on group_shares');
select ok(not has_column_privilege('authenticated', 'public.group_entries', 'linked_user_id', 'insert'), 'authenticated: cannot insert linked_user_id');
select ok(not has_column_privilege('authenticated', 'public.group_entries', 'linked_user_id', 'update'), 'authenticated: cannot update linked_user_id');
select ok(not has_column_privilege('authenticated', 'public.travel_groups', 'parsed_structure', 'update'), 'authenticated: cannot update parsed_structure');
select ok(has_function_privilege('authenticated', 'public.claim_group_entry(uuid)', 'execute'), 'authenticated may execute claim_group_entry');
select ok(not has_function_privilege('anon', 'public.claim_group_entry(uuid)', 'execute'), 'anon may not execute claim_group_entry');
select ok(has_function_privilege('authenticated', 'public.unclaim_group_entry(uuid)', 'execute'), 'authenticated may execute unclaim_group_entry');
select ok(not has_function_privilege('anon', 'public.unclaim_group_entry(uuid)', 'execute'), 'anon may not execute unclaim_group_entry');
select ok(has_function_privilege('authenticated', 'private.writable_group_ids()', 'execute'), 'authenticated may execute writable_group_ids');
select ok(not has_function_privilege('anon', 'private.writable_group_ids()', 'execute'), 'anon may not execute writable_group_ids');
select ok(not has_function_privilege('authenticated', 'private.group_usable_by(uuid, uuid)', 'execute'), 'authenticated may not probe group_usable_by');
select ok(not has_function_privilege('authenticated', 'private.group_reachable(uuid, uuid)', 'execute'), 'authenticated may not probe group_reachable');
select ok(not has_function_privilege('authenticated', 'private.prune_group_links(uuid, uuid)', 'execute'), 'authenticated may not run prune_group_links');
select ok(not has_function_privilege('authenticated', 'private.inherit_group_owner()', 'execute'), 'trigger function inherit_group_owner is not executable by authenticated');
select ok(not has_function_privilege('authenticated', 'private.group_entries_guard()', 'execute'), 'trigger function group_entries_guard is not executable by authenticated');
select ok(has_function_privilege('authenticated', 'public.replace_group_entries(uuid, jsonb, jsonb, timestamptz)', 'execute'), 'authenticated may execute replace_group_entries');
select ok(not has_function_privilege('anon', 'public.replace_group_entries(uuid, jsonb, jsonb, timestamptz)', 'execute'), 'anon may not execute replace_group_entries');

reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select throws_ok($$insert into public.group_shares (owner_id, group_id, grantee_id, access) values ('6a000000-0000-4000-8000-0000000000a1', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000b2', 'write')$$,
  '42501', null, 'A cannot insert a group share directly');
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000b2', 'write')$$, '42501', null, 'authenticated cannot call share_resource');
reset role;
set local role anon;
select throws_ok($$select public.claim_group_entry('6a000000-0000-4000-8000-00000000e003')$$, '42501', null, 'anon cannot claim');
reset role;

-- ---------- share_resource for groups, as service_role ----------
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000b2', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000c3', 'read')$$, 'P0001', 'not_found', 'B as p_owner for the group of A: not_found');
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000b001', '6a000000-0000-4000-8000-0000000000c3', 'read')$$, 'P0001', 'not_found', 'A as p_owner for the group of B: not_found');
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a201', '6a000000-0000-4000-8000-0000000000c3', 'read')$$, 'P0001', 'not_found', 'a trip id used as group id: not_found');
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000e5', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000c3', 'read')$$, 'P0001', 'forbidden', 'demo account as owner: forbidden');
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000a1', 'read')$$, 'P0001', 'self_share', 'sharing with oneself: self_share');
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000e5', 'read')$$, 'P0001', 'no_account', 'demo account as grantee: no_account');
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000ff', 'read')$$, 'P0001', 'no_account', 'unknown grantee: no_account');
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000b2', 'admin')$$, 'P0001', 'invalid', 'unknown access level: invalid');
select is((select count(*)::int from public.group_shares), 0, 'failed calls created no group share');

select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000b2', 'write') s), true, 'A shares group GA with B (write)');
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000c3', 'read') s), true, 'A shares group GA with C (read)');
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a004', '6a000000-0000-4000-8000-0000000000b2', 'write') s), true, 'A shares group GAX with B (write)');
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000f6', 'group', '6a000000-0000-4000-8000-00000000f001', '6a000000-0000-4000-8000-0000000000b2', 'read') s), true, 'F shares group GF with B (read)');
select is((select owner_id from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a001' and grantee_id = '6a000000-0000-4000-8000-0000000000b2'), '6a000000-0000-4000-8000-0000000000a1'::uuid, 'the share row carries the checked owner');
-- a repeat call changes the access, created = false, no second row
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000b2', 'read') s), false, 'a repeat call returns created = false');
select is((select access from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a001' and grantee_id = '6a000000-0000-4000-8000-0000000000b2'), 'read', 'a repeat call changed the access');
select is((select count(*)::int from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a001' and grantee_id = '6a000000-0000-4000-8000-0000000000b2'), 1, 'a repeat call created no second row');
-- update-only path
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000b2', 'write',
            (select id from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a001' and grantee_id = '6a000000-0000-4000-8000-0000000000b2')) s), false, 'p_share_id that matches changes the access');
select is((select access from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a001' and grantee_id = '6a000000-0000-4000-8000-0000000000b2'), 'write', 'the update-only path set write');
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000b2', 'read',
  (select id from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a001' and grantee_id = '6a000000-0000-4000-8000-0000000000c3'))$$, 'P0001', 'not_found', 'p_share_id of another grantee row: not_found');
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000b2', 'read',
  (select id from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a004' and grantee_id = '6a000000-0000-4000-8000-0000000000b2'))$$, 'P0001', 'not_found', 'p_share_id of another group row: not_found');
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000b2', 'read', '6a000000-0000-4000-8000-0000000000ff')$$, 'P0001', 'not_found', 'p_share_id that does not exist: not_found');
select is((select access from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a001' and grantee_id = '6a000000-0000-4000-8000-0000000000b2'), 'write', 'failed update-only calls changed nothing');
-- cap: 10 grantees per group
select is((select count(*)::int from generate_series(1, 10) g,
    lateral public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a003', ('6a000000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'read') r
   where r.created), 10, 'A shares group GACAP with 10 grantees');
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a003', '6a000000-0000-4000-8000-000000000111', 'read')$$, 'P0001', 'limit_reached', 'the 11th grantee of a group: limit_reached');
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a003', '6a000000-0000-4000-8000-000000000101', 'write') s), false, 'at 10 grantees a change of access still works');
select is((select count(*)::int from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a003'), 10, 'the group still has exactly 10 share rows');
-- a grantee that left, then a stale access change: not_found, no row re-created
reset role;
set local request.jwt.claims = '{}';
do $$ begin
  perform set_config('test.gone', (select id::text from public.group_shares
    where group_id = '6a000000-0000-4000-8000-00000000a003' and grantee_id = '6a000000-0000-4000-8000-000000000102'), true);
end $$;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000102","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.group_shares where id = current_setting('test.gone')::uuid and grantee_id = (select auth.uid()) returning 1)
select is((select count(*)::int from d), 1, 'a grantee can leave (delete own row)');
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a003', '6a000000-0000-4000-8000-000000000102', 'write', current_setting('test.gone')::uuid)$$,
  'P0001', 'not_found', 'p_share_id of a row the grantee deleted: not_found');
select is((select count(*)::int from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a003' and grantee_id = '6a000000-0000-4000-8000-000000000102'), 0, 'the stale access change did not re-create the grant');

-- trip shares for the transitive recipients
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'trip', '6a000000-0000-4000-8000-00000000a201', '6a000000-0000-4000-8000-000000000071', 'read') s), true, 'A shares trip TA1 (group GA) with T (read)');

-- fixtures that need a usable group: trips and searches of B and C, B shares one trip with R
reset role;
set local request.jwt.claims = '{}';
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, group_id, updated_at) values
  ('6a000000-0000-4000-8000-00000000b201', '6a000000-0000-4000-8000-0000000000b2', 'freetext', 'B trip with GA', 3, '6a000000-0000-4000-8000-00000000a001', '2020-01-01 00:00+00'),
  ('6a000000-0000-4000-8000-00000000c201', '6a000000-0000-4000-8000-0000000000c3', 'freetext', 'C trip with GA', 3, '6a000000-0000-4000-8000-00000000a001', '2020-01-01 00:00+00');
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, group_id) values
  ('6a000000-0000-4000-8000-00000000b202', '6a000000-0000-4000-8000-0000000000b2', 'freetext', 'B trip with GB', 3, '6a000000-0000-4000-8000-00000000b001'),
  ('6a000000-0000-4000-8000-00000000b203', '6a000000-0000-4000-8000-0000000000b2', 'freetext', 'B trip with GAX', 3, '6a000000-0000-4000-8000-00000000a004'),
  ('6a000000-0000-4000-8000-00000000b204', '6a000000-0000-4000-8000-0000000000b2', 'freetext', 'B trip with GF', 3, '6a000000-0000-4000-8000-00000000f001');
insert into public.destination_searches (id, owner_id, group_id, purpose_name, locale, input_hash, input, status) values
  ('6a000000-0000-4000-8000-00000000b301', '6a000000-0000-4000-8000-0000000000b2', '6a000000-0000-4000-8000-00000000a001',  'B search GA',  'en', repeat('1', 64), '{}', 'done'),
  ('6a000000-0000-4000-8000-00000000b302', '6a000000-0000-4000-8000-0000000000b2', '6a000000-0000-4000-8000-00000000a004', 'B search GAX', 'en', repeat('2', 64), '{}', 'done'),
  ('6a000000-0000-4000-8000-00000000c301', '6a000000-0000-4000-8000-0000000000c3', '6a000000-0000-4000-8000-00000000a001',  'C search GA',  'en', repeat('3', 64), '{}', 'done');
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000b2', 'trip', '6a000000-0000-4000-8000-00000000b201', '6a000000-0000-4000-8000-000000000072', 'read') s), true, 'B shares trip TB1 (group GA of A) with R (read)');
reset role;
set local request.jwt.claims = '{}';

-- ---------- visibility ----------
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 1, 'B (write) sees the shared group');
select is((select count(*)::int from public.group_entries where group_id = '6a000000-0000-4000-8000-00000000a001'), 8, 'B sees all 8 entries of the shared group');
select is((select count(*)::int from public.group_shares where grantee_id = (select auth.uid()) and group_id = '6a000000-0000-4000-8000-00000000a001'), 1, 'B sees the own incoming group share row');
select is((select count(*)::int from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a003'), 0, 'B sees no share row of a group it has no part in');
select is((select count(*)::int from public.travel_groups where owner_id = (select auth.uid()) and id = '6a000000-0000-4000-8000-00000000a001'), 0, 'own list (owner_id = auth.uid()) excludes the shared group');
select is((select count(*)::int from public.group_entries where id = '6a000000-0000-4000-8000-00000000e002' and is_self), 1, 'B sees the is_self entry');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 1, 'C (read) sees the shared group');
select is((select count(*)::int from public.group_entries where group_id = '6a000000-0000-4000-8000-00000000a001'), 8, 'C sees all entries');
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a004'), 0, 'C does not see a group shared with B only');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where id in ('6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-00000000a004')), 0, 'D sees no shared group');
select is((select count(*)::int from public.group_entries where group_id = '6a000000-0000-4000-8000-00000000a001'), 0, 'D sees no entry');
select is((select count(*)::int from public.group_shares), 0, 'D sees no group share row');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000071","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 1, 'T sees the group through the shared trip');
select is((select count(*)::int from public.group_entries where group_id = '6a000000-0000-4000-8000-00000000a001'), 8, 'T sees its entries through the shared trip');
select is((select count(*)::int from public.group_shares), 0, 'T has no group share row');
select ok(not ('6a000000-0000-4000-8000-00000000a001'::uuid = any ((select private.writable_group_ids())::uuid[])), 'T has no write access to the group');
with u as (update public.travel_groups set name = 'T edit' where id = '6a000000-0000-4000-8000-00000000a001' returning 1)
select is((select count(*)::int from u), 0, 'T cannot update the group seen through a trip');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000072","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 1, 'R sees A''s group through B''s trip (transitive)');
select is((select count(*)::int from public.group_entries where group_id = '6a000000-0000-4000-8000-00000000a001'), 8, 'R sees its entries (transitive)');
with u as (update public.group_entries set name = 'R edit' where group_id = '6a000000-0000-4000-8000-00000000a001' returning 1)
select is((select count(*)::int from u), 0, 'R cannot update entries of the group');
select throws_ok($$insert into public.group_entries (group_id, kind, name) values ('6a000000-0000-4000-8000-00000000a001', 'member', 'R entry')$$, '42501', null, 'R cannot add an entry');
reset role;
set local request.jwt.claims = '{}';

-- ---------- writes: B (write) ----------
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
with u as (update public.travel_groups set name = 'A family by B', notes = 'n by B', description = 'd by B', trait_keys = '{diet}' where id = '6a000000-0000-4000-8000-00000000a001' returning 1)
select is((select count(*)::int from u), 1, 'B updates name, notes, description and trait_keys');
select is((select name from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 'A family by B', 'the update is visible');
with i as (insert into public.group_entries (group_id, kind, name, "position") values ('6a000000-0000-4000-8000-00000000a001', 'member', 'Newbie', 9) returning owner_id)
select is((select owner_id from i), '6a000000-0000-4000-8000-0000000000a1'::uuid, 'an entry inserted by B takes the group owner as owner_id');
with u as (update public.group_entries set name = 'Benny' where id = '6a000000-0000-4000-8000-00000000e003' returning 1)
select is((select count(*)::int from u), 1, 'B updates a plain entry');
with d as (delete from public.group_entries where group_id = '6a000000-0000-4000-8000-00000000a001' and name = 'Newbie' returning 1)
select is((select count(*)::int from d), 1, 'B deletes a plain entry');
with u as (update public.group_entries set label = 'Ali', notes = 'owner note', traits = '{"diet":"vegetarian"}' where id = '6a000000-0000-4000-8000-00000000e002' returning 1)
select is((select count(*)::int from u), 1, 'B edits label, notes and traits of the is_self entry (G21)');
select lives_ok($$select public.replace_group_entries('6a000000-0000-4000-8000-00000000a001', '{"name":"A family by B","notes":null,"description":"d2","trait_keys":["diet"]}'::jsonb,
  (select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'position', e."position", 'count', e.count, 'label', e.label, 'name', e.name,
     'is_self', e.is_self, 'birthdate', e.birthdate, 'age_mode', e.age_mode, 'age', e.age, 'age_as_of', e.age_as_of, 'notes', e.notes, 'traits', e.traits))
     from public.group_entries e where e.group_id = '6a000000-0000-4000-8000-00000000a001'))$$, 'B runs replace_group_entries with the full list');
select is((select description from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 'd2', 'replace_group_entries by B saved the description');
select lives_ok($$select public.reorder_group_entries('6a000000-0000-4000-8000-00000000a001', (select array_agg(e.id order by e."position" desc) from public.group_entries e where e.group_id = '6a000000-0000-4000-8000-00000000a001'))$$, 'B reorders the entries');
select is((select "position"::int from public.group_entries where id = '6a000000-0000-4000-8000-00000000e008'), 0, 'the reorder took effect');
select lives_ok($$select public.reorder_group_entries('6a000000-0000-4000-8000-00000000a001', (select array_agg(e.id order by e."position" desc) from public.group_entries e where e.group_id = '6a000000-0000-4000-8000-00000000a001'))$$, 'B reorders back');
with d as (delete from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001' returning 1)
select is((select count(*)::int from d), 0, 'B cannot delete the group');
select throws_ok($$update public.travel_groups set parsed_structure = '[]' where id = '6a000000-0000-4000-8000-00000000a001'$$, '42501', null, 'B cannot write parsed_structure');
select throws_ok($$update public.group_entries set group_id = '6a000000-0000-4000-8000-00000000b001' where id = '6a000000-0000-4000-8000-00000000e003'$$, '42501', null, 'B cannot move an entry to another group (no group_id update privilege)');
select throws_ok($$update public.group_entries set owner_id = '6a000000-0000-4000-8000-0000000000b2' where id = '6a000000-0000-4000-8000-00000000e003'$$, '42501', null, 'B cannot change the owner_id of an entry');
select throws_ok($$update public.travel_groups set owner_id = '6a000000-0000-4000-8000-0000000000b2' where id = '6a000000-0000-4000-8000-00000000a001'$$, '42501', null, 'B cannot change the owner_id of the group');
select throws_ok($$update public.group_entries set linked_user_id = '6a000000-0000-4000-8000-0000000000b2' where id = '6a000000-0000-4000-8000-00000000e003'$$, '42501', null, 'B cannot write linked_user_id');
select throws_ok($$insert into public.group_entries (group_id, kind, name, linked_user_id) values ('6a000000-0000-4000-8000-00000000a001', 'member', 'Sneaky', '6a000000-0000-4000-8000-0000000000b2')$$, '42501', null, 'B cannot insert linked_user_id');
select throws_ok($$insert into public.group_entries (group_id, kind, is_self) values ('6a000000-0000-4000-8000-00000000a001', 'member', true)$$, '42501', 'owner_only', 'B cannot insert an is_self entry');
select throws_ok($$update public.group_entries set is_self = true, name = null where id = '6a000000-0000-4000-8000-00000000e003'$$, '42501', 'owner_only', 'B cannot make another entry is_self');
select throws_ok($$update public.group_entries set is_self = false, name = 'NotMe' where id = '6a000000-0000-4000-8000-00000000e002'$$, '42501', 'owner_only', 'B cannot clear is_self');
select throws_ok($$delete from public.group_entries where id = '6a000000-0000-4000-8000-00000000e002'$$, '42501', 'owner_only', 'B cannot delete the is_self entry');
select throws_ok($$select public.replace_group_entries('6a000000-0000-4000-8000-00000000a001', '{"name":"dropped self","trait_keys":[]}'::jsonb,
  (select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'position', e."position", 'count', e.count, 'name', e.name, 'is_self', e.is_self, 'traits', e.traits))
     from public.group_entries e where e.group_id = '6a000000-0000-4000-8000-00000000a001' and not e.is_self))$$, '42501', 'owner_only', 'B cannot drop the is_self entry through replace_group_entries');
select is((select name from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 'A family by B', 'the failed replace changed nothing (atomic)');
reset role;
set local request.jwt.claims = '{}';
select is((select count(*)::int from public.group_entries where group_id = '6a000000-0000-4000-8000-00000000a001' and is_self), 1, 'the is_self entry is still there');

-- ---------- writes: C (read) ----------
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
with u as (update public.travel_groups set name = 'C edit' where id = '6a000000-0000-4000-8000-00000000a001' returning 1)
select is((select count(*)::int from u), 0, 'C (read) cannot update the group');
select throws_ok($$insert into public.group_entries (group_id, kind, name) values ('6a000000-0000-4000-8000-00000000a001', 'member', 'C entry')$$, '42501', null, 'C (read) cannot insert an entry');
with u as (update public.group_entries set name = 'C edit' where group_id = '6a000000-0000-4000-8000-00000000a001' returning 1)
select is((select count(*)::int from u), 0, 'C (read) cannot update an entry');
with d as (delete from public.group_entries where group_id = '6a000000-0000-4000-8000-00000000a001' returning 1)
select is((select count(*)::int from d), 0, 'C (read) cannot delete an entry');
select throws_ok($$select public.replace_group_entries('6a000000-0000-4000-8000-00000000a001', '{"name":"C edit","trait_keys":[]}'::jsonb, '[]'::jsonb)$$, 'P0002', 'group_not_found', 'C (read) cannot run replace_group_entries');
select lives_ok($$select public.reorder_group_entries('6a000000-0000-4000-8000-00000000a001', (select array_agg(e.id order by e."position" desc) from public.group_entries e where e.group_id = '6a000000-0000-4000-8000-00000000a001'))$$, 'C reorder runs but changes nothing');
select is((select "position"::int from public.group_entries where id = '6a000000-0000-4000-8000-00000000e008'), 7, 'C (read) reorder did not move any entry');
reset role;
set local request.jwt.claims = '{}';
select is((select name from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 'A family by B', 'nothing C tried changed the group');

-- ---------- replace_group_entries: optimistic check ----------
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select public.replace_group_entries('6a000000-0000-4000-8000-00000000a001', '{"name":"stale","trait_keys":[]}'::jsonb,
  (select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'position', e."position", 'count', e.count, 'name', e.name, 'is_self', e.is_self, 'traits', e.traits))
     from public.group_entries e where e.group_id = '6a000000-0000-4000-8000-00000000a001'), '2000-01-01 00:00+00')$$, '40001', 'conflict', 'a stale p_expected_updated_at: 40001 conflict');
select is((select name from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 'A family by B', 'the conflicting save changed nothing');
select lives_ok($$select public.replace_group_entries('6a000000-0000-4000-8000-00000000a001', '{"name":"A family","trait_keys":["diet"]}'::jsonb,
  (select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'position', e."position", 'count', e.count, 'label', e.label, 'name', e.name, 'is_self', e.is_self, 'traits', e.traits))
     from public.group_entries e where e.group_id = '6a000000-0000-4000-8000-00000000a001'),
  (select updated_at from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'))$$, 'the current updated_at passes');
select lives_ok($$select public.replace_group_entries('6a000000-0000-4000-8000-00000000a001', '{"name":"A family","trait_keys":["diet"]}'::jsonb,
  (select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'position', e."position", 'count', e.count, 'label', e.label, 'name', e.name, 'is_self', e.is_self, 'traits', e.traits))
     from public.group_entries e where e.group_id = '6a000000-0000-4000-8000-00000000a001'), null)$$, 'a null p_expected_updated_at passes');
select lives_ok($$select public.replace_group_entries(p_group_id => '6a000000-0000-4000-8000-00000000a001', p_group => '{"name":"A family","trait_keys":["diet"]}'::jsonb,
  p_entries => (select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'position', e."position", 'count', e.count, 'label', e.label, 'name', e.name, 'is_self', e.is_self, 'traits', e.traits))
     from public.group_entries e where e.group_id = '6a000000-0000-4000-8000-00000000a001'))$$, 'three named arguments still resolve');
select throws_ok($$select public.replace_group_entries('6a000000-0000-4000-8000-0000000000ff', '{"name":"x"}'::jsonb, '[]'::jsonb)$$, 'P0002', 'group_not_found', 'an unknown group: P0002');
reset role;
set local request.jwt.claims = '{}';

-- ---------- claims ("That's me") ----------
do $$ begin
  perform set_config('test.ga_upd', (select updated_at::text from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), true);
end $$;
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e005')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'C (read) claims an eligible entry and gets the group id');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e005'), '6a000000-0000-4000-8000-0000000000c3'::uuid, 'the link is set');
select throws_ok($$select public.claim_group_entry('6a000000-0000-4000-8000-00000000e001')$$, 'P0001', 'not_eligible', 'claiming a composition: not_eligible');
select throws_ok($$select public.claim_group_entry('6a000000-0000-4000-8000-00000000e002')$$, 'P0001', 'not_eligible', 'claiming the is_self entry: not_eligible');
select throws_ok($$select public.claim_group_entry('6a000000-0000-4000-8000-00000000e003')$$, 'P0001', 'already_claimed', 'C claiming a second entry: already_claimed');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e005'), '6a000000-0000-4000-8000-0000000000c3'::uuid, 'the first link stays after a refused second claim');
select is((select count(*)::int from public.group_entries where linked_user_id = '6a000000-0000-4000-8000-0000000000c3'), 1, 'C has exactly one link');
select lives_ok($$select public.claim_group_entry('6a000000-0000-4000-8000-00000000e005')$$, 'claiming the own entry again is a no-op');
reset role;
set local request.jwt.claims = '{}';
select is((select updated_at::text from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), current_setting('test.ga_upd'), 'a claim does not touch the updated_at of the group');
select is((select updated_at from public.trips where id = '6a000000-0000-4000-8000-00000000a201'), '2020-01-01 00:00+00'::timestamptz, 'a claim does not touch the trips of the owner');
select ok((select updated_at from public.trips where id = '6a000000-0000-4000-8000-00000000c201') > '2021-01-01'::timestamptz, 'a claim bumps updated_at of the claimer''s trips with this group');
select is((select updated_at from public.trips where id = '6a000000-0000-4000-8000-00000000b201'), '2020-01-01 00:00+00'::timestamptz, 'a claim does not touch the trips of other users');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select public.claim_group_entry('6a000000-0000-4000-8000-00000000e005')$$, 'P0001', 'already_linked', 'B claiming the entry of C: already_linked');
select throws_ok($$select * from public.unclaim_group_entry('6a000000-0000-4000-8000-00000000e005')$$, 'P0001', 'forbidden', 'B (write) cannot remove the link of C');
select throws_ok($$delete from public.group_entries where id = '6a000000-0000-4000-8000-00000000e005'$$, '42501', 'linked_entry', 'B cannot delete an entry linked to C');
select throws_ok($$update public.group_entries set kind = 'composition', name = null where id = '6a000000-0000-4000-8000-00000000e005'$$, '42501', 'linked_entry', 'B cannot make an entry linked to C ineligible');
select throws_ok($$select public.replace_group_entries('6a000000-0000-4000-8000-00000000a001', '{"name":"dropped linked","trait_keys":[]}'::jsonb,
  (select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'position', e."position", 'count', e.count, 'name', e.name, 'is_self', e.is_self, 'traits', e.traits))
     from public.group_entries e where e.group_id = '6a000000-0000-4000-8000-00000000a001' and e.id <> '6a000000-0000-4000-8000-00000000e005'))$$, '42501', 'linked_entry', 'B cannot drop an entry linked to C through replace_group_entries');
select lives_ok($$update public.group_entries set name = 'Cara Z' where id = '6a000000-0000-4000-8000-00000000e005'$$, 'B can edit the typed data of a linked entry');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e005'), '6a000000-0000-4000-8000-0000000000c3'::uuid, 'editing the typed data keeps the link');
-- B links an entry and may delete it again
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e006')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'B (write) claims an entry');
with d as (delete from public.group_entries where id = '6a000000-0000-4000-8000-00000000e006' returning 1)
select is((select count(*)::int from d), 1, 'B can delete an entry linked to B');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select public.claim_group_entry('6a000000-0000-4000-8000-00000000e003')$$, 'P0001', 'forbidden', 'A (the owner) cannot claim');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select public.claim_group_entry('6a000000-0000-4000-8000-00000000e003')$$, 'P0001', 'not_found', 'D claiming an entry it cannot see: not_found');
select throws_ok($$select * from public.unclaim_group_entry('6a000000-0000-4000-8000-00000000e005')$$, 'P0001', 'not_found', 'D unclaiming an entry it cannot see: not_found');
select throws_ok($$select * from public.unclaim_group_entry('6a000000-0000-4000-8000-00000000e003')$$, 'P0001', 'not_found', 'D unclaiming an unlinked entry it cannot see: not_found');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select u.by_owner from public.unclaim_group_entry('6a000000-0000-4000-8000-00000000e005') u), false, 'C undoes the own link (by_owner = false)');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e005'), null::uuid, 'the link is gone');
select is((select u.by_owner from public.unclaim_group_entry('6a000000-0000-4000-8000-00000000e005') u), false, 'unclaiming an unlinked entry is a no-op');
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e004')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'after the undo C can claim another entry');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select is((select u.by_owner from public.unclaim_group_entry('6a000000-0000-4000-8000-00000000e004') u), true, 'A removes the link of C (by_owner = true)');
select is((select count(*)::int from public.group_entries where linked_user_id is not null), 0, 'no link left');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e005')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'C can link again right away after a removal');
reset role;
set local request.jwt.claims = '{}';
-- the trip-only recipients claim through the shared trips
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000071","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e007')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'T (trip-only, trip of A) claims an entry');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000072","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e003')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'R (trip-only, trip of B) claims an entry');
reset role;
set local request.jwt.claims = '{}';

-- A: ineligible clears the link, delete of a linked entry is the owner's right
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select lives_ok($$update public.group_entries set kind = 'composition', name = null, count = 1 where id = '6a000000-0000-4000-8000-00000000e007'$$, 'A makes the entry linked to T ineligible');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e007'), null::uuid, 'the link of T was cleared with it');
reset role;
set local request.jwt.claims = '{}';
update public.group_entries set kind = 'member', name = 'Dee' where id = '6a000000-0000-4000-8000-00000000e007';
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000071","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e007')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'T links again');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.group_entries where id = '6a000000-0000-4000-8000-00000000e007' returning 1)
select is((select count(*)::int from d), 1, 'A can delete an entry linked to T');
reset role;
set local request.jwt.claims = '{}';
insert into public.group_entries (id, group_id, owner_id, kind, name, "position") values ('6a000000-0000-4000-8000-00000000e007', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000a1', 'member', 'Dee', 6);
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000071","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e007')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'T links the re-created entry');
reset role;
set local request.jwt.claims = '{}';
select is((select count(*)::int from public.group_entries where linked_user_id is not null), 3, 'three links: C, T and R');

-- ---------- share_contacts ----------
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select is((select display_name from public.share_contacts() where user_id = '6a000000-0000-4000-8000-000000000072'), 'Rae', 'A sees the display name of R (transitive claimer)');
select is((select email from public.share_contacts() where user_id = '6a000000-0000-4000-8000-000000000072'), '', 'A gets an empty email for R, who is not a share counterpart');
select is((select email from public.share_contacts() where user_id = '6a000000-0000-4000-8000-0000000000b2'), 'b@gshare.test', 'A gets the email of the group grantee B');
select is((select count(*)::int from public.share_contacts() where user_id = '6a000000-0000-4000-8000-0000000000c3'), 1, 'A''s contacts include C');
select is((select count(*)::int from public.share_contacts() where user_id = '6a000000-0000-4000-8000-000000000105'), 1, 'A''s contacts include a grantee of GACAP');
select is((select count(*)::int from public.share_contacts() where user_id = '6a000000-0000-4000-8000-0000000000d4'), 0, 'A''s contacts do not include the stranger D');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.share_contacts() where user_id = '6a000000-0000-4000-8000-0000000000a1'), 1, 'B''s contacts include A (incoming group share)');
select is((select count(*)::int from public.share_contacts() where user_id = '6a000000-0000-4000-8000-0000000000c3'), 0, 'B''s contacts do not include C');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000072","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.share_contacts() where user_id = '6a000000-0000-4000-8000-0000000000a1'), 0, 'R''s contacts do not include A (R only linked an entry)');
select is((select count(*)::int from public.share_contacts() where user_id = '6a000000-0000-4000-8000-0000000000b2'), 1, 'R''s contacts include B (trip share)');
reset role;
set local request.jwt.claims = '{}';

-- ---------- using a shared group for own trips and searches ----------
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select lives_ok($$insert into public.trips (dest_kind, dest_name, length_days, group_id) values ('freetext', 'B new', 3, '6a000000-0000-4000-8000-00000000a001')$$, 'B (write) attaches GA to a new trip');
select lives_ok($$update public.trips set group_id = '6a000000-0000-4000-8000-00000000a001' where id = '6a000000-0000-4000-8000-00000000b202'$$, 'B attaches GA to an existing trip');
select lives_ok($$update public.trips set group_id = '6a000000-0000-4000-8000-00000000b001' where id = '6a000000-0000-4000-8000-00000000b202'$$, 'B moves it back to the own group');
select lives_ok($$insert into public.destination_searches (group_id, purpose_name, locale, input_hash, input, status) values ('6a000000-0000-4000-8000-00000000a001', 'B search', 'en', repeat('4', 64), '{}', 'done')$$, 'B attaches GA to a search');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select lives_ok($$insert into public.trips (dest_kind, dest_name, length_days, group_id) values ('freetext', 'C new', 3, '6a000000-0000-4000-8000-00000000a001')$$, 'C (read) attaches GA to a new trip');
select lives_ok($$insert into public.destination_searches (group_id, purpose_name, locale, input_hash, input, status) values ('6a000000-0000-4000-8000-00000000a001', 'C search', 'en', repeat('5', 64), '{}', 'done')$$, 'C attaches GA to a search');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, group_id) values ('freetext', 'C new', 3, '6a000000-0000-4000-8000-00000000a004')$$, '23503', null, 'C cannot attach a group shared with B only');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, group_id) values ('freetext', 'D new', 3, '6a000000-0000-4000-8000-00000000a001')$$, '23503', null, 'D cannot attach GA to a new trip');
select throws_ok($$update public.trips set group_id = '6a000000-0000-4000-8000-00000000a001' where id = '6a000000-0000-4000-8000-00000000d201'$$, '23503', null, 'D cannot attach GA to an existing trip');
select throws_ok($$insert into public.destination_searches (group_id, purpose_name, locale, input_hash, input, status) values ('6a000000-0000-4000-8000-00000000a001', 'D search', 'en', repeat('6', 64), '{}', 'done')$$, '23503', null, 'D cannot attach GA to a search');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000071","role":"authenticated"}';
set local role authenticated;
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, group_id) values ('freetext', 'T new', 3, '6a000000-0000-4000-8000-00000000a001')$$, '23503', null, 'T cannot attach a group seen only through a shared trip');
select throws_ok($$update public.trips set group_id = '6a000000-0000-4000-8000-00000000a001' where id = '6a000000-0000-4000-8000-00000000e201'$$, '23503', null, 'T cannot re-point an own trip to a group seen only through a trip');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000072","role":"authenticated"}';
set local role authenticated;
select throws_ok($$insert into public.destination_searches (group_id, purpose_name, locale, input_hash, input, status) values ('6a000000-0000-4000-8000-00000000a001', 'R search', 'en', repeat('7', 64), '{}', 'done')$$, '23503', null, 'R cannot attach a transitive group to a search');
reset role;
set local request.jwt.claims = '{}';

-- ---------- pruning: every route counts ----------
-- links now: C (group share), T (trip share of TA1), R (trip share of TB1, which uses GA)
-- a. trip share revoked: T's link is cleared
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.trip_shares where trip_id = '6a000000-0000-4000-8000-00000000a201' and grantee_id = '6a000000-0000-4000-8000-000000000071' returning 1)
select is((select count(*)::int from d), 1, 'A revokes the trip share of T');
reset role;
set local request.jwt.claims = '{}';
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e007'), null::uuid, 'prune: T''s link is cleared when its trip share is revoked');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e005'), '6a000000-0000-4000-8000-0000000000c3'::uuid, 'prune: C''s link is untouched (group share route)');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e003'), '6a000000-0000-4000-8000-000000000072'::uuid, 'prune: R''s link is untouched');
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'trip', '6a000000-0000-4000-8000-00000000a201', '6a000000-0000-4000-8000-000000000071', 'read') s), true, 'A shares TA1 with T again');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000071","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e007')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'T claims again');
-- b. the trip moves to another group: T's link is cleared
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select lives_ok($$update public.trips set group_id = '6a000000-0000-4000-8000-00000000a002' where id = '6a000000-0000-4000-8000-00000000a201'$$, 'A moves TA1 to another group');
reset role;
set local request.jwt.claims = '{}';
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e007'), null::uuid, 'prune: T''s link is cleared when the trip moves to another group');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select lives_ok($$update public.trips set group_id = '6a000000-0000-4000-8000-00000000a001' where id = '6a000000-0000-4000-8000-00000000a201'$$, 'A moves TA1 back');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000071","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e007')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'T claims again after the move back');
-- c. two routes: the link survives until both are gone
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-000000000071', 'read') s), true, 'A also shares the group itself with T');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.trip_shares where trip_id = '6a000000-0000-4000-8000-00000000a201' and grantee_id = '6a000000-0000-4000-8000-000000000071' returning 1)
select is((select count(*)::int from d), 1, 'A revokes the trip share of T');
reset role;
set local request.jwt.claims = '{}';
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e007'), '6a000000-0000-4000-8000-000000000071'::uuid, 'prune: T keeps the link through the group share');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a001' and grantee_id = '6a000000-0000-4000-8000-000000000071' returning 1)
select is((select count(*)::int from d), 1, 'A revokes the group share of T');
reset role;
set local request.jwt.claims = '{}';
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e007'), null::uuid, 'prune: T''s link is cleared when the last route ends');
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'trip', '6a000000-0000-4000-8000-00000000a201', '6a000000-0000-4000-8000-000000000071', 'read') s), true, 'A shares TA1 with T again (2)');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000071","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e007')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'T claims again (2)');

-- d. A revokes B's group share: B's trips and searches lose the group, R's link goes
reset role;
set local request.jwt.claims = '{}';
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, group_id, updated_at)
  values ('6a000000-0000-4000-8000-00000000b205', '6a000000-0000-4000-8000-0000000000b2', 'freetext', 'B trip to watch', 3, '6a000000-0000-4000-8000-00000000a001', '2020-01-01 00:00+00');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a001' and grantee_id = '6a000000-0000-4000-8000-0000000000b2' returning 1)
select is((select count(*)::int from d), 1, 'A revokes the group share of B');
reset role;
set local request.jwt.claims = '{}';
select is((select count(*)::int from public.trips where owner_id = '6a000000-0000-4000-8000-0000000000b2' and group_id = '6a000000-0000-4000-8000-00000000a001'), 0, 'unshare: no trip of B uses the group any more');
select is((select count(*)::int from public.destination_searches where owner_id = '6a000000-0000-4000-8000-0000000000b2' and group_id = '6a000000-0000-4000-8000-00000000a001'), 0, 'unshare: no search of B uses the group any more');
select is((select count(*)::int from public.destination_searches where id = '6a000000-0000-4000-8000-00000000b301'), 1, 'unshare: the search of B keeps its cards (row stays)');
select ok((select updated_at from public.trips where id = '6a000000-0000-4000-8000-00000000b205') > '2021-01-01'::timestamptz, 'unshare: the trip of B has a new updated_at (plan shows as outdated)');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e003'), null::uuid, 'chain: R''s link is cleared (B''s trip lost the group)');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e005'), '6a000000-0000-4000-8000-0000000000c3'::uuid, 'chain: C''s link is untouched');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e007'), '6a000000-0000-4000-8000-000000000071'::uuid, 'chain: T''s link is untouched');
select is((select count(*)::int from public.trips where id = '6a000000-0000-4000-8000-00000000b201' and group_id is null), 1, 'unshare: B''s trip shared with R lost the group');
-- e. R keeps the link when R also has a group share
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000b2', 'write') s), true, 'A shares GA with B again');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select lives_ok($$update public.trips set group_id = '6a000000-0000-4000-8000-00000000a001' where id = '6a000000-0000-4000-8000-00000000b201'$$, 'B re-attaches GA to the trip shared with R');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000072","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e003')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'R claims again through the trip of B');
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-000000000072', 'read') s), true, 'A also shares GA with R');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a001' and grantee_id = '6a000000-0000-4000-8000-0000000000b2' returning 1)
select is((select count(*)::int from d), 1, 'A revokes the group share of B again');
reset role;
set local request.jwt.claims = '{}';
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e003'), '6a000000-0000-4000-8000-000000000072'::uuid, 'prune: R keeps the link through its own group share');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a001' and grantee_id = '6a000000-0000-4000-8000-000000000072' returning 1)
select is((select count(*)::int from d), 1, 'A revokes the group share of R');
reset role;
set local request.jwt.claims = '{}';
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e003'), null::uuid, 'prune: R''s link is cleared when the group share ends and the trip no longer has the group');
-- f. B moves the trip to another group
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000b2', 'write') s), true, 'A shares GA with B (3)');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select lives_ok($$update public.trips set group_id = '6a000000-0000-4000-8000-00000000a001' where id = '6a000000-0000-4000-8000-00000000b201'$$, 'B re-attaches GA (2)');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000072","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e003')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'R claims again (2)');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select lives_ok($$update public.trips set group_id = '6a000000-0000-4000-8000-00000000b001' where id = '6a000000-0000-4000-8000-00000000b201'$$, 'B moves the trip to the own group');
reset role;
set local request.jwt.claims = '{}';
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e003'), null::uuid, 'prune: R''s link is cleared when B moves the trip to another group');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select lives_ok($$update public.trips set group_id = '6a000000-0000-4000-8000-00000000a001' where id = '6a000000-0000-4000-8000-00000000b201'$$, 'B re-attaches GA (3)');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000072","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e003')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'R claims again (3)');
-- g. C leaves the group share
reset role;
set local request.jwt.claims = '{}';
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, group_id, updated_at)
  values ('6a000000-0000-4000-8000-00000000c202', '6a000000-0000-4000-8000-0000000000c3', 'freetext', 'C trip to watch', 3, '6a000000-0000-4000-8000-00000000a001', '2020-01-01 00:00+00');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a001' and grantee_id = (select auth.uid()) returning 1)
select is((select count(*)::int from d), 1, 'C leaves the group share');
reset role;
set local request.jwt.claims = '{}';
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e005'), null::uuid, 'prune: C''s link is cleared when C leaves');
select is((select count(*)::int from public.trips where owner_id = '6a000000-0000-4000-8000-0000000000c3' and group_id = '6a000000-0000-4000-8000-00000000a001'), 0, 'leave: C''s trips lost the group');
select is((select count(*)::int from public.destination_searches where owner_id = '6a000000-0000-4000-8000-0000000000c3' and group_id = '6a000000-0000-4000-8000-00000000a001'), 0, 'leave: C''s searches lost the group');
select ok((select updated_at from public.trips where id = '6a000000-0000-4000-8000-00000000c202') > '2021-01-01'::timestamptz, 'leave: the trip of C has a new updated_at');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e003'), '6a000000-0000-4000-8000-000000000072'::uuid, 'prune: R''s link is untouched by C leaving');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 0, 'C no longer sees the group');
-- h. the group is deleted
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a004' returning 1)
select is((select count(*)::int from d), 1, 'A deletes the group GAX');
reset role;
set local request.jwt.claims = '{}';
select is((select count(*)::int from public.trips where id = '6a000000-0000-4000-8000-00000000b203' and group_id is null), 1, 'group delete: the trip of B lost the group');
select is((select count(*)::int from public.destination_searches where id = '6a000000-0000-4000-8000-00000000b302' and group_id is null), 1, 'group delete: the search of B lost the group');
select is((select count(*)::int from public.group_shares where group_id = '6a000000-0000-4000-8000-00000000a004'), 0, 'group delete: the share rows are gone');
-- i. the trip is deleted
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.trips where id = '6a000000-0000-4000-8000-00000000a201' returning 1)
select is((select count(*)::int from d), 1, 'A deletes the trip TA1');
reset role;
set local request.jwt.claims = '{}';
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e007'), null::uuid, 'prune: T''s link is cleared when the trip is deleted');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e003'), '6a000000-0000-4000-8000-000000000072'::uuid, 'prune: R''s link is untouched by the deletion of another trip');

-- ---------- account deletion ----------
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-000000000101', 'read') s), true, 'A shares GA with G01');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000101","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e008')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'G01 claims an entry');
reset role;
set local request.jwt.claims = '{}';
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e008'), '6a000000-0000-4000-8000-000000000101'::uuid, 'G01 is linked');
delete from auth.users where id = '6a000000-0000-4000-8000-000000000101';
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e008'), null::uuid, 'deleting the linked account clears the link');
select is((select count(*)::int from public.group_shares where grantee_id = '6a000000-0000-4000-8000-000000000101'), 0, 'deleting a grantee removes its share rows');

-- ---------- disabled owners ----------
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select s.created from public.share_resource('6a000000-0000-4000-8000-0000000000a1', 'group', '6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000c3', 'read') s), true, 'A shares GA with C again');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select public.claim_group_entry('6a000000-0000-4000-8000-00000000e005')), '6a000000-0000-4000-8000-00000000a001'::uuid, 'C claims again');
reset role;
set local request.jwt.claims = '{}';
do $$ begin
  perform set_config('test.links', (select count(*)::text from public.group_entries where linked_user_id is not null), true);
end $$;
update public.profiles set disabled_at = now() where id = '6a000000-0000-4000-8000-0000000000a1';
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 0, 'A disabled: C no longer sees the group');
select is((select count(*)::int from public.group_entries where group_id = '6a000000-0000-4000-8000-00000000a001'), 0, 'A disabled: C sees no entries');
select is((select count(*)::int from public.group_shares), 0, 'A disabled: C sees no share row');
select throws_ok($$select public.claim_group_entry('6a000000-0000-4000-8000-00000000e004')$$, 'P0001', 'not_found', 'A disabled: no claim');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000072","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 0, 'A disabled: R no longer sees the group through the trip of B');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.group_entries where group_id = '6a000000-0000-4000-8000-00000000a001'), 0, 'A disabled: B sees no entries');
select throws_ok($$update public.trips set group_id = '6a000000-0000-4000-8000-00000000a001' where id = '6a000000-0000-4000-8000-00000000b202'$$, '23503', null, 'A disabled: B cannot attach the group');
reset role;
set local request.jwt.claims = '{}';
select is((select count(*)::text from public.group_entries where linked_user_id is not null), current_setting('test.links'), 'A disabled: the links stay');
select is(private.group_usable_by('6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000c3'), false, 'A disabled: the group is not usable by C');
select is(private.group_reachable('6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-0000000000c3'), true, 'A disabled: group_reachable ignores is_active');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select u.by_owner from public.unclaim_group_entry('6a000000-0000-4000-8000-00000000e005') u), false, 'A disabled: C can still undo the own link');
reset role;
set local request.jwt.claims = '{}';
update public.group_entries set linked_user_id = '6a000000-0000-4000-8000-0000000000c3' where id = '6a000000-0000-4000-8000-00000000e005';
update public.profiles set disabled_at = null where id = '6a000000-0000-4000-8000-0000000000a1';
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 1, 'A re-enabled: C sees the group again');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e005'), '6a000000-0000-4000-8000-0000000000c3'::uuid, 'A re-enabled: the link is back');
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000072","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 1, 'A re-enabled: R sees the group through the trip of B again');
-- F: the group owner of GF is disabled, B uses GF
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000f001'), 1, 'F active: B sees the group of F');
select lives_ok($$update public.trips set group_id = '6a000000-0000-4000-8000-00000000f001' where id = '6a000000-0000-4000-8000-00000000b204'$$, 'F active: B attaches GF');
reset role;
set local request.jwt.claims = '{}';
update public.profiles set disabled_at = now() where id = '6a000000-0000-4000-8000-0000000000f6';
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000f001'), 0, 'F disabled: B no longer sees the group of F');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, group_id) values ('freetext', 'B GF', 3, '6a000000-0000-4000-8000-00000000f001')$$, '23503', null, 'F disabled: a new trip cannot use the group of F');
select throws_ok($$insert into public.destination_searches (group_id, purpose_name, locale, input_hash, input, status) values ('6a000000-0000-4000-8000-00000000f001', 'B GF', 'en', repeat('8', 64), '{}', 'done')$$, '23503', null, 'F disabled: a search cannot use the group of F');
select lives_ok($$update public.trips set dest_name = 'still editable', group_id = '6a000000-0000-4000-8000-00000000f001' where id = '6a000000-0000-4000-8000-00000000b204'$$, 'F disabled: an unchanged group reference does not block edits');
reset role;
set local request.jwt.claims = '{}';
select is(private.group_usable_by('6a000000-0000-4000-8000-00000000f001', '6a000000-0000-4000-8000-0000000000b2'), false, 'F disabled: the group of F is not usable by B');
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select throws_ok($$select * from public.share_resource('6a000000-0000-4000-8000-0000000000f6', 'group', '6a000000-0000-4000-8000-00000000f001', '6a000000-0000-4000-8000-0000000000c3', 'read')$$, 'P0001', 'forbidden', 'F disabled: F cannot share');
reset role;
set local request.jwt.claims = '{}';
update public.profiles set disabled_at = null where id = '6a000000-0000-4000-8000-0000000000f6';
reset role;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000f001'), 1, 'F re-enabled: B sees the group of F again');

-- ---------- admin aggregate ----------
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select is((select (public.admin_share_stats(now() - interval '1 day') ->> 'groupSharesRead')::int), (select count(*)::int from public.group_shares where access = 'read'), 'admin_share_stats counts read group shares');
select is((select (public.admin_share_stats(now() - interval '1 day') ->> 'groupSharesWrite')::int), (select count(*)::int from public.group_shares where access = 'write'), 'admin_share_stats counts write group shares');
select is((select (public.admin_share_stats(now() - interval '1 day') ->> 'groupsShared')::int), (select count(distinct group_id)::int from public.group_shares), 'admin_share_stats counts distinct shared groups');
select is((select (public.admin_share_stats(now() - interval '1 day') ->> 'entryLinks')::int), (select count(*)::int from public.group_entries where linked_user_id is not null), 'admin_share_stats counts entry links');
select is((select (public.admin_share_stats(now() - interval '1 day') ->> 'recipients')::int),
  (select count(distinct g)::int from (select grantee_id g from public.trip_shares union all select grantee_id from public.purpose_shares union all select grantee_id from public.group_shares) x), 'admin_share_stats recipients include group grantees');
select ok((select (public.admin_share_stats(now() - interval '1 day') ->> 'grantsThisMonth')::int) >= (select count(*)::int from public.group_shares), 'admin_share_stats grants include group shares');
select is((select count(*)::int from jsonb_object_keys(public.admin_share_stats(now() - interval '1 day'))), 13, 'admin_share_stats returns thirteen counters and nothing else');
select ok((public.admin_share_stats(now() - interval '1 day'))::text !~ '[0-9a-f]{8}-[0-9a-f]{4}-', 'admin_share_stats holds no ids');
reset role;
set local request.jwt.claims = '{}';

-- ---------- account deletion of owners ----------
-- a trip owner whose shared trip uses someone else's group: B's trip TB1 (group of A) is shared with R, R is linked
reset role;
set local request.jwt.claims = '{}';
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e003'), '6a000000-0000-4000-8000-000000000072'::uuid, 'sanity: R is linked through the trip of B');
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, group_id) values ('6a000000-0000-4000-8000-00000000c203', '6a000000-0000-4000-8000-0000000000c3', 'freetext', 'C trip with GA 3', 3, '6a000000-0000-4000-8000-00000000a001');
insert into public.destination_searches (id, owner_id, group_id, purpose_name, locale, input_hash, input, status)
  values ('6a000000-0000-4000-8000-00000000c302', '6a000000-0000-4000-8000-0000000000c3', '6a000000-0000-4000-8000-00000000a001', 'C search GA 2', 'en', repeat('9', 64), '{}', 'done');
delete from auth.users where id = '6a000000-0000-4000-8000-0000000000b2';
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e003'), null::uuid, 'deleting the trip owner prunes the link that relied on the trip route');
select is((select linked_user_id from public.group_entries where id = '6a000000-0000-4000-8000-00000000e005'), '6a000000-0000-4000-8000-0000000000c3'::uuid, 'deleting the trip owner leaves the link of C (group share route)');
select is((select count(*)::int from public.group_shares where grantee_id = '6a000000-0000-4000-8000-0000000000b2'), 0, 'deleting a grantee removes its group shares');
select is((select count(*)::int from public.travel_groups where id = '6a000000-0000-4000-8000-00000000a001'), 1, 'deleting a grantee leaves the group');
-- the group owner: groups, shares, entries, links go; recipients keep trips and searches without the group
delete from auth.users where id = '6a000000-0000-4000-8000-0000000000a1';
select is((select count(*)::int from public.travel_groups where owner_id = '6a000000-0000-4000-8000-0000000000a1'), 0, 'deleting the group owner deletes the groups');
select is((select count(*)::int from public.group_shares where owner_id = '6a000000-0000-4000-8000-0000000000a1'), 0, 'deleting the group owner deletes the group shares');
select is((select count(*)::int from public.group_entries where group_id in ('6a000000-0000-4000-8000-00000000a001', '6a000000-0000-4000-8000-00000000a002', '6a000000-0000-4000-8000-00000000a003')), 0, 'deleting the group owner deletes the entries');
select is((select count(*)::int from public.group_entries where linked_user_id is not null), 0, 'no link is left');
select is((select count(*)::int from public.trips where id = '6a000000-0000-4000-8000-00000000c203' and group_id is null), 1, 'the trip of C stays and lost the group');
select is((select count(*)::int from public.destination_searches where id = '6a000000-0000-4000-8000-00000000c302' and group_id is null), 1, 'the search of C stays and lost the group');
select is((select count(*)::int from public.group_shares), 0, 'no group share is left');

select * from finish();
rollback;
