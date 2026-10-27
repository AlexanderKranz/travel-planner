-- pgTAP RLS / grants tests. Run with `supabase test db` (CI job `db-test`, see .github/workflows/ci.yml).
-- Written against migrations 20261027120001..9. Runs as postgres inside one transaction that is rolled back.
-- Uses no_plan() because the file is still being extended; finish() reports failures and `supabase test db`
-- exits non-zero on any failed test.
begin;
-- pgTAP ships with the local Supabase Postgres image but is not enabled by default.
create extension if not exists pgtap with schema extensions;
-- Make pgTAP functions resolvable regardless of the role search_path (also after `set local role`).
set local search_path = public, extensions;
select * from no_plan();

-- ---------- fixtures: two users + one admin (inserted as postgres; triggers create profiles) ----------
insert into public.signup_allowlist (email) values ('a@test.dev'), ('b@test.dev'), ('admin@test.dev');
insert into auth.users (id, email, raw_user_meta_data, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a@test.dev', '{"locale":"en"}', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b@test.dev', '{}',              'authenticated', 'authenticated'),
  ('cccccccc-0000-4000-8000-000000000003', 'admin@test.dev', '{}',          'authenticated', 'authenticated');
update public.profiles set role = 'admin' where id = 'cccccccc-0000-4000-8000-000000000003';

select is((select count(*)::int from public.profiles), 3, 'signup trigger created 3 profiles');
select is((select locale from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000001'), 'en', 'locale from metadata');
select is((select count(*)::int from public.signup_allowlist where used_at is not null), 3, 'allowlist entries marked used');

-- seed user A content as postgres
insert into public.travel_groups (id, owner_id, name) values
  ('a0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'A family');
insert into public.group_entries (group_id, owner_id, kind, count) values
  ('a0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'composition', 4);
insert into public.trip_purposes (id, owner_id, name) values
  ('a0000000-0000-4000-8000-0000000000b1', 'aaaaaaaa-0000-4000-8000-000000000001', 'A golf');

-- ---------- user B must not see or touch user A ----------
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups), 0, 'B sees no groups of A');
select is((select count(*)::int from public.group_entries), 0, 'B sees no entries of A');
select is((select count(*)::int from public.trip_purposes), 0, 'B sees no purposes of A');
select is((select count(*)::int from public.profiles), 1, 'B sees only own profile');
select is((select count(*)::int from public.signup_allowlist), 0, 'B sees no allowlist');
select is((select count(*)::int from public.app_events), 0, 'B sees no app_events');

with u as (update public.travel_groups set name = 'pwned' where id = 'a0000000-0000-4000-8000-0000000000a1' returning 1)
select is((select count(*)::int from u), 0, 'B cannot update A group');
with d as (delete from public.travel_groups where id = 'a0000000-0000-4000-8000-0000000000a1' returning 1)
select is((select count(*)::int from d), 0, 'B cannot delete A group');
with u as (update public.trip_purposes set name = 'pwned' where id = 'a0000000-0000-4000-8000-0000000000b1' returning 1)
select is((select count(*)::int from u), 0, 'B cannot update A purpose');

select throws_ok($$insert into public.travel_groups (owner_id, name) values ('aaaaaaaa-0000-4000-8000-000000000001', 'x')$$,
  '42501', null, 'B cannot insert a group owned by A (owner_id is not in the insert column grant)');
-- owner_id is not insertable by users (column grant), so it defaults to auth.uid() = B and the composite FK rejects A's group
select throws_ok($$insert into public.group_entries (group_id, kind) values ('a0000000-0000-4000-8000-0000000000a1', 'composition')$$,
  '23503', null, 'B cannot attach an entry to A group (composite FK group_id, owner_id)');
select throws_ok($$insert into public.group_entries (group_id, owner_id, kind) values ('a0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'composition')$$,
  '42501', null, 'B cannot insert an entry as owner A (owner_id column not granted)');

-- ---------- privilege escalation / protected columns (column-level grants) ----------
select throws_ok($$update public.profiles set role = 'admin' where id = 'bbbbbbbb-0000-4000-8000-000000000002'$$,
  '42501', null, 'user cannot promote self to admin (column grant)');
select throws_ok($$update public.trip_purposes set parsed_tags = '{}' where owner_id = 'bbbbbbbb-0000-4000-8000-000000000002'$$,
  '42501', null, 'user cannot write parsed_tags');
select throws_ok($$insert into public.trip_purposes (name, parsed_hash) values ('x', 'h')$$,
  '42501', null, 'user cannot insert parsed_hash');
select throws_ok($$insert into public.app_events (event) values ('x.y')$$, '42501', null, 'user cannot write app_events');
select throws_ok($$insert into public.signup_allowlist (email) values ('evil@test.dev')$$, '42501', null, 'non-admin cannot insert allowlist');
select throws_ok($$update public.profiles set locale = 'fr' where id = 'bbbbbbbb-0000-4000-8000-000000000002'$$,
  '23514', null, 'profiles.locale is limited to de/en');
select throws_ok($$update public.profiles set home_airports = '{FRA,MUC,HAM,BER,CGN,DUS}' where id = 'bbbbbbbb-0000-4000-8000-000000000002'$$,
  '23514', null, 'at most 5 home airports');
select throws_ok($$insert into public.trip_purposes (name, constraints) values ('x', array[repeat('a', 201)])$$,
  '23514', null, 'constraint elements are length-limited');
select throws_ok($$insert into public.trip_purposes (name, guided) values ('x', jsonb_build_object('k', repeat('a', 9000)))$$,
  '23514', null, 'guided jsonb is size-limited');
select throws_ok($$insert into public.signup_allowlist (email, used_at) values ('x@test.dev', now())$$,
  '42501', null, 'used_at is not insertable by users');
select throws_ok($$update public.travel_groups set owner_id = 'bbbbbbbb-0000-4000-8000-000000000002' where false$$,
  '42501', null, 'owner_id is not updatable');
select throws_ok($$update public.profiles set id = gen_random_uuid() where id = 'bbbbbbbb-0000-4000-8000-000000000002'$$,
  '42501', null, 'user cannot change profile id');
select lives_ok($$update public.profiles set display_name = 'Bee' where id = 'bbbbbbbb-0000-4000-8000-000000000002'$$, 'user can update display_name');
select lives_ok($$insert into public.trip_purposes (name, text, guided, constraints) values ('mine', 't', '{}', '{}')$$, 'user can insert purpose via granted columns (owner_id default)');

-- ---------- atomic group functions (security invoker, RLS applies) ----------
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
select lives_ok($$select public.replace_group_entries('a0000000-0000-4000-8000-0000000000a1',
  '{"name":"A family 2","notes":null}'::jsonb,
  '[{"kind":"composition","position":0,"count":2,"is_self":false,"traits":{}}]'::jsonb)$$, 'A can replace own group entries');
select is((select name from public.travel_groups where id = 'a0000000-0000-4000-8000-0000000000a1'), 'A family 2', 'group renamed');
select is((select count(*)::int from public.group_entries where group_id = 'a0000000-0000-4000-8000-0000000000a1'), 1, 'old entry removed, new inserted');
select throws_ok($$select public.replace_group_entries('a0000000-0000-4000-8000-0000000000a1', '{"name":"x"}'::jsonb,
  '[{"kind":"composition","position":0,"count":0,"is_self":false,"traits":{}}]'::jsonb)$$, '23514', null, 'invalid entry aborts the whole call');
select is((select name from public.travel_groups where id = 'a0000000-0000-4000-8000-0000000000a1'), 'A family 2', 'rolled back: group name unchanged after failed call');
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select public.replace_group_entries('a0000000-0000-4000-8000-0000000000a1', '{"name":"pwn"}'::jsonb, '[]'::jsonb)$$,
  'P0002', null, 'B cannot replace entries of A group (RLS hides it)');
select lives_ok($$select public.reorder_group_entries('a0000000-0000-4000-8000-0000000000a1', '{}')$$, 'reorder on a foreign group: no-op or reject') ;

-- ---------- grant matrix ----------
reset role;
select ok(not has_table_privilege('authenticated', 'public.profiles', 'insert'), 'authenticated: no table-level insert on profiles');
select ok(not has_table_privilege('authenticated', 'public.profiles', 'delete'), 'authenticated: no delete on profiles');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'role', 'update'), 'authenticated: cannot update profiles.role');
select ok(not has_column_privilege('authenticated', 'public.trip_purposes', 'parsed_tags', 'update'), 'authenticated: cannot update parsed_tags');
select ok(not has_column_privilege('authenticated', 'public.trip_purposes', 'parsed_tags', 'insert'), 'authenticated: cannot insert parsed_tags');
select ok(not has_table_privilege('authenticated', 'public.app_events', 'insert'), 'authenticated: no insert on app_events');
select ok(not has_table_privilege('authenticated', 'public.signup_allowlist', 'update'), 'authenticated: no update on allowlist');
select ok(not has_function_privilege('anon', 'public.replace_group_entries(uuid, jsonb, jsonb)', 'execute'), 'anon cannot call replace_group_entries');
select ok(has_function_privilege('anon', 'public.health_check()', 'execute'), 'anon can call health_check');
select ok(has_function_privilege('authenticated', 'public.health_check()', 'execute'), 'authenticated can call health_check');
select ok(not exists (
  select 1 from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon'), 'anon has no table grants in public');

-- ---------- demo account ----------
reset role;
select ok(not has_column_privilege('authenticated', 'public.profiles', 'is_demo', 'update'), 'authenticated: cannot update profiles.is_demo');
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;
select throws_ok($$update public.profiles set is_demo = true where id = 'bbbbbbbb-0000-4000-8000-000000000002'$$,
  '42501', null, 'user cannot flag self as demo');
reset role;
-- as postgres (the secret-key path): the CHECK still keeps demo and admin apart, in both directions
select throws_ok($$update public.profiles set is_demo = true where id = 'cccccccc-0000-4000-8000-000000000003'$$,
  '23514', null, 'an admin cannot become demo');
update public.profiles set is_demo = true where id = 'bbbbbbbb-0000-4000-8000-000000000002';
select throws_ok($$update public.profiles set role = 'admin' where id = 'bbbbbbbb-0000-4000-8000-000000000002'$$,
  '23514', null, 'demo user can never be admin');
update public.profiles set is_demo = false where id = 'bbbbbbbb-0000-4000-8000-000000000002';

-- ---------- -- anon sees nothing ----------
reset role;
set local request.jwt.claims = '';
set local role anon;
select throws_ok($$select * from public.profiles$$, '42501', null, 'anon cannot read profiles');
select throws_ok($$select * from public.travel_groups$$, '42501', null, 'anon cannot read groups');
select throws_ok($$select * from public.app_events$$, '42501', null, 'anon cannot read app_events');
select throws_ok($$select * from public.signup_allowlist$$, '42501', null, 'anon cannot read allowlist');
select lives_ok($$select public.health_check()$$, 'anon may call health_check');
select throws_ok($$select public.hook_before_user_created('{}'::jsonb)$$, '42501', null, 'anon cannot call the auth hook');

-- ---------- admin: aggregates only, no content ----------
reset role;
set local request.jwt.claims = '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.travel_groups), 0, 'admin sees no user groups');
select is((select count(*)::int from public.signup_allowlist), 3, 'admin sees the allowlist');

-- ---------- fail-closed signup trigger (second layer behind the hook) ----------
reset role;
select throws_ok($$insert into auth.users (id, email, aud, role) values (gen_random_uuid(), 'stranger@test.dev', 'authenticated', 'authenticated')$$,
  'P0001', 'signup_not_allowed', 'unlisted email cannot be created even without the hook');
select throws_ok($$insert into auth.users (id, email, aud, role) values (gen_random_uuid(), null, 'authenticated', 'authenticated')$$,
  'P0001', 'signup_not_allowed', 'user without email is rejected');
select throws_ok($$insert into public.signup_allowlist (email) values (' padded@test.dev')$$, '23514', null, 'allowlist email must be trimmed');

-- ---------- hook behaviour ----------
reset role;
select is(public.hook_before_user_created('{"user":{"email":"A@Test.dev"}}'::jsonb), '{}'::jsonb, 'hook allows listed email (case-insensitive)');
select is((public.hook_before_user_created('{"user":{"email":"nobody@test.dev"}}'::jsonb) -> 'error' ->> 'http_code'), '403', 'hook rejects unlisted email');

select * from finish();
rollback;

-- TODO (separate scripts, need the HTTP stack, see e2e/):
--  * PostgREST: GET /rest/v1/profiles with the anon key returns 401/[]; /rest/v1/rpc/hook_before_user_created -> 401/403
--  * GoTrue: signInWithOtp for an unlisted email returns 403 signup_not_allowed; listed email gets mail (Inbucket)
--  * delete user via admin API -> profiles/groups/entries/purposes gone, app_events.user_id null
--  * enumerate pg_class: every relation in schema public has relrowsecurity = true (see query below)
-- select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
--  where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity;   -- must return 0 rows
