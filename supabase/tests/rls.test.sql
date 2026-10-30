-- pgTAP RLS / grants tests. Run with `supabase test db` (CI job `db-test`, see .github/workflows/ci.yml).
-- Written against migrations 20261027120001..20261103120027. Runs as postgres inside one transaction that is rolled back.
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

-- ---------- travel_groups.trait_keys ----------
-- backfill helper (as postgres): ordered keys that appear non-null in any entry's traits
reset role;
insert into public.group_entries (group_id, owner_id, kind, count, traits) values
  ('a0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'composition', 1, '{"needsNap":true,"mobility":"stroller","diet":null}'),
  ('a0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'composition', 1, '{"golfHandicap":0}');
select is(private.group_trait_keys_used('a0000000-0000-4000-8000-0000000000a1'), '{mobility,golfHandicap,needsNap}'::text[], 'backfill: ordered keys used by entries, null ignored');
select is(private.group_trait_keys_used('a0000000-0000-4000-8000-0000000000ff'), '{}'::text[], 'backfill: no entries -> empty');
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
select lives_ok($$update public.travel_groups set trait_keys = '{mobility,needsNap}' where id = 'a0000000-0000-4000-8000-0000000000a1'$$, 'owner can set valid trait_keys');
select is((select trait_keys from public.travel_groups where id = 'a0000000-0000-4000-8000-0000000000a1'), '{mobility,needsNap}'::text[], 'trait_keys stored in order');
select throws_ok($$update public.travel_groups set trait_keys = '{mobility,bogus}' where id = 'a0000000-0000-4000-8000-0000000000a1'$$, '23514', null, 'unknown trait key rejected');
select throws_ok($$update public.travel_groups set trait_keys = '{diet,diet}' where id = 'a0000000-0000-4000-8000-0000000000a1'$$, '23514', null, 'duplicate trait keys rejected');
select lives_ok($$select public.replace_group_entries('a0000000-0000-4000-8000-0000000000a1', '{"name":"A family 2","notes":null,"trait_keys":["golfHandicap"]}'::jsonb, '[]'::jsonb)$$, 'replace_group_entries sets trait_keys');
select is((select trait_keys from public.travel_groups where id = 'a0000000-0000-4000-8000-0000000000a1'), '{golfHandicap}'::text[], 'trait_keys updated by replace_group_entries');
select throws_ok($$select public.replace_group_entries('a0000000-0000-4000-8000-0000000000a1', '{"name":"x","trait_keys":["nope"]}'::jsonb, '[]'::jsonb)$$, '23514', null, 'replace_group_entries rejects unknown trait key');
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;
with u as (update public.travel_groups set trait_keys = '{diet}' where id = 'a0000000-0000-4000-8000-0000000000a1' returning 1)
select is((select count(*)::int from u), 0, 'B cannot update trait_keys of A group');

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

-- ---------- phase 2: trips, api_cache, api_calls (migrations 20261029120011..13) ----------
reset role;
set local request.jwt.claims = '';
insert into public.travel_groups (id, owner_id, name) values
  ('b0000000-0000-4000-8000-0000000000a1', 'bbbbbbbb-0000-4000-8000-000000000002', 'B group');
insert into public.trip_purposes (id, owner_id, name) values
  ('b0000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'B purpose');

-- fixture trip for A is inserted as postgres: `id` and `owner_id` are NOT in the insert column grant, so a user
-- session cannot choose them (see migration 20261029120013).
reset role;
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, group_id, purpose_id) values
  ('a0000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'Somewhere', 3,
   'a0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000b1');

-- as user A: create trips (owner_id comes from the column default)
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
select lives_ok($$insert into public.trips (title, dest_kind, dest_name, length_days, group_id, purpose_id) values
  ('own-default', 'freetext', 'Somewhere', 3, 'a0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000b1')$$,
  'A can create a freetext trip with own group and purpose');
select is((select owner_id from public.trips where title = 'own-default'),
  'aaaaaaaa-0000-4000-8000-000000000001'::uuid, 'owner_id defaults to auth.uid()');
select throws_ok($$insert into public.trips (id, dest_kind, dest_name, length_days) values (gen_random_uuid(), 'freetext', 'X', 2)$$,
  '42501', null, 'id cannot be written on insert');
select lives_ok($$insert into public.trips (dest_kind, dest_name, dest_place_name, dest_geo_id, dest_lat, dest_lon, length_days, months)
  values ('city', 'Passau', 'Passau', 2855328, 48.5665, 13.43122, 7, '{12}')$$, 'A can create a geocoded trip with months');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, group_id) values
  ('freetext', 'X', 2, 'b0000000-0000-4000-8000-0000000000a1')$$, '23503', null, 'A cannot reference B''s group');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, purpose_id) values
  ('freetext', 'X', 2, 'b0000000-0000-4000-8000-0000000000b1')$$, '23503', null, 'A cannot reference B''s purpose');
select throws_ok($$insert into public.trips (owner_id, dest_kind, dest_name, length_days) values
  ('bbbbbbbb-0000-4000-8000-000000000002', 'freetext', 'X', 2)$$, '42501', null, 'owner_id cannot be written');
select throws_ok($$update public.trips set owner_id = 'bbbbbbbb-0000-4000-8000-000000000002' where id = 'a0000000-0000-4000-8000-0000000000c1'$$,
  '42501', null, 'owner_id cannot be updated');
select throws_ok($$update public.trips set id = gen_random_uuid() where id = 'a0000000-0000-4000-8000-0000000000c1'$$,
  '42501', null, 'id cannot be updated');

-- checks
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, dest_lat, dest_lon) values ('freetext', 'X', 2, 1, 1)$$,
  '23514', null, 'freetext with coordinates rejected');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days) values ('city', 'X', 2)$$,
  '23514', null, 'city without coordinates rejected');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, start_date, months) values ('freetext', 'X', 2, '2027-01-01', '{1}')$$,
  '23514', null, 'date + months rejected');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, months) values ('freetext', 'X', 2, '{13}')$$,
  '23514', null, 'month 13 rejected');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days) values ('freetext', 'X', 0)$$,
  '23514', null, 'length_days 0 rejected');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days) values ('freetext', 'X', 61)$$,
  '23514', null, 'length_days 61 rejected');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, origin_airports) values ('freetext', 'X', 2, '{fra}')$$,
  '23514', null, 'origin_airports must be IATA format');

select throws_ok($$update public.trips set group_id = 'b0000000-0000-4000-8000-0000000000a1' where id = 'a0000000-0000-4000-8000-0000000000c1'$$,
  '23503', null, 'A cannot re-point own trip to B''s group');
select throws_ok($$update public.trips set purpose_id = 'b0000000-0000-4000-8000-0000000000b1' where id = 'a0000000-0000-4000-8000-0000000000c1'$$,
  '23503', null, 'A cannot re-point own trip to B''s purpose');
select lives_ok($$update public.trips set group_id = null, purpose_id = null where id = 'a0000000-0000-4000-8000-0000000000c1'$$,
  'A can clear group and purpose (all context optional)');
select lives_ok($$update public.trips set group_id = 'a0000000-0000-4000-8000-0000000000a1', purpose_id = 'a0000000-0000-4000-8000-0000000000b1'
  where id = 'a0000000-0000-4000-8000-0000000000c1'$$, 'A can re-attach own group and purpose');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, dest_country_code) values ('freetext', 'X', 2, 'de')$$,
  '23514', null, 'lowercase country code rejected');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, start_date) values ('freetext', 'X', 2, '1999-12-31')$$,
  '23514', null, 'start_date before 2000 rejected');
select throws_ok($$insert into public.trips (dest_kind, dest_name, length_days, dest_radius_km, dest_lat, dest_lon, dest_geo_id, dest_place_name)
  values ('region', 'X', 2, 201, 1, 1, 1, 'X')$$, '23514', null, 'radius over 200 km rejected');

-- user B cannot see or touch A's trips
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*)::int from public.trips), 0, 'B sees no trips of A');
update public.trips set dest_name = 'hacked' where id = 'a0000000-0000-4000-8000-0000000000c1';
delete from public.trips where id = 'a0000000-0000-4000-8000-0000000000c1';
reset role;
select is((select dest_name from public.trips where id = 'a0000000-0000-4000-8000-0000000000c1'), 'Somewhere', 'B cannot update A''s trip');
select is((select count(*)::int from public.trips where id = 'a0000000-0000-4000-8000-0000000000c1'), 1, 'B cannot delete A''s trip');

-- deleting a group / purpose clears only the reference column
delete from public.travel_groups where id = 'a0000000-0000-4000-8000-0000000000a1';
delete from public.trip_purposes where id = 'a0000000-0000-4000-8000-0000000000b1';
select is((select group_id from public.trips where id = 'a0000000-0000-4000-8000-0000000000c1'), null, 'group delete sets trips.group_id null');
select is((select purpose_id from public.trips where id = 'a0000000-0000-4000-8000-0000000000c1'), null, 'purpose delete sets trips.purpose_id null');
select is((select owner_id from public.trips where id = 'a0000000-0000-4000-8000-0000000000c1'),
  'aaaaaaaa-0000-4000-8000-000000000001'::uuid, 'owner_id survives the set-null action');

-- anon
set local request.jwt.claims = '';
set local role anon;
select throws_ok($$select * from public.trips$$, '42501', null, 'anon cannot read trips');
select throws_ok($$select * from public.api_cache$$, '42501', null, 'anon cannot read api_cache');
select throws_ok($$select * from public.api_calls$$, '42501', null, 'anon cannot read api_calls');

select ok(not has_table_privilege('authenticated', 'public.api_cache', 'select'), 'authenticated has no select on api_cache');
select ok(not has_table_privilege('authenticated', 'public.api_cache', 'insert'), 'authenticated has no insert on api_cache');
select ok(not has_table_privilege('anon', 'public.api_cache', 'select'), 'anon has no select on api_cache');
select ok(not has_table_privilege('authenticated', 'public.api_calls', 'insert'), 'authenticated has no insert on api_calls');
select ok(not has_table_privilege('authenticated', 'public.api_calls', 'delete'), 'authenticated has no delete on api_calls');
select ok(not has_table_privilege('anon', 'public.api_calls', 'select'), 'anon has no select on api_calls');
select ok((select relrowsecurity from pg_class where oid = 'public.api_cache'::regclass), 'RLS enabled on api_cache');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'api_cache'), 0, 'api_cache has no policies');
select ok(not has_column_privilege('authenticated', 'public.trips', 'owner_id', 'insert'), 'authenticated cannot insert trips.owner_id');
select ok(not has_column_privilege('authenticated', 'public.trips', 'id', 'insert'), 'authenticated cannot insert trips.id');
select ok(not has_column_privilege('authenticated', 'public.trips', 'created_at', 'update'), 'authenticated cannot update trips.created_at');
select ok(not has_table_privilege('authenticated', 'public.trips', 'truncate'), 'authenticated cannot truncate trips');
select ok(exists (select 1 from pg_constraint where conname = 'trip_purposes_id_owner_key' and conrelid = 'public.trip_purposes'::regclass),
  'trip_purposes (id, owner_id) unique constraint exists');

-- api_cache: no access for authenticated, including admin
reset role;
insert into public.api_cache (provider, cache_key, payload, expires_at) values ('overpass', 'k', '{}'::jsonb, now() + interval '1 day');
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select * from public.api_cache$$, '42501', null, 'user cannot select api_cache');
select throws_ok($$insert into public.api_cache (provider, cache_key, payload, expires_at) values ('overpass', 'x', '{}'::jsonb, now())$$,
  '42501', null, 'user cannot insert into api_cache');
reset role;
set local request.jwt.claims = '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select * from public.api_cache$$, '42501', null, 'admin cannot select api_cache');
select throws_ok($$insert into public.api_cache (provider, cache_key, payload, expires_at) values ('overpass', 'x', '{}'::jsonb, now())$$,
  '42501', null, 'admin cannot insert into api_cache');

-- api_calls: admin reads, others see nothing, nobody but the server writes
reset role;
insert into public.api_calls (provider, endpoint, cache, ok) values ('overpass', 'interpreter', 'miss', true);
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.api_calls), 0, 'non-admin sees no api_calls');
select throws_ok($$insert into public.api_calls (provider, endpoint, cache, ok) values ('overpass', 'x', 'hit', true)$$,
  '42501', null, 'user cannot insert api_calls');
reset role;
set local request.jwt.claims = '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.api_calls), 1, 'admin can read api_calls');
select throws_ok($$insert into public.api_calls (provider, endpoint, cache, ok) values ('overpass', 'x', 'hit', true)$$,
  '42501', null, 'admin cannot insert api_calls');
reset role;

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

-- ---------- onboarding flag ----------
reset role;
select is((select onboarding_done_at from public.profiles where id = 'bbbbbbbb-0000-4000-8000-000000000002'), null, 'new profiles (signup trigger) start without onboarding_done_at');
select ok(has_column_privilege('authenticated', 'public.profiles', 'onboarding_done_at', 'update'), 'authenticated: can update profiles.onboarding_done_at');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'role', 'update'), 'authenticated: still cannot update profiles.role');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'is_demo', 'update'), 'authenticated: still cannot update profiles.is_demo');
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;
update public.profiles set onboarding_done_at = now() where id = 'bbbbbbbb-0000-4000-8000-000000000002';
select isnt((select onboarding_done_at from public.profiles where id = 'bbbbbbbb-0000-4000-8000-000000000002'), null, 'user can set own onboarding_done_at');
with u as (update public.profiles set onboarding_done_at = now() where id = 'aaaaaaaa-0000-4000-8000-000000000001' returning 1)
select is((select count(*)::int from u), 0, 'user cannot set onboarding_done_at of another user (RLS)');
reset role;
select is((select onboarding_done_at from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000001'), null, 'other user flag unchanged');

-- ---------- home location ----------
select ok(has_column_privilege('authenticated', 'public.profiles', 'home_location', 'update'), 'authenticated: can update profiles.home_location');
select ok(has_column_privilege('authenticated', 'public.profiles', 'home_timezone', 'update'), 'authenticated: can update profiles.home_timezone');
select ok(has_column_privilege('authenticated', 'public.profiles', 'onboarding_done_at', 'update'), 'authenticated: grant still includes onboarding_done_at');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'role', 'update'), 'authenticated: home grant did not open profiles.role');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'is_demo', 'update'), 'authenticated: home grant did not open profiles.is_demo');

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

-- ---------- trip retention (migration 20261029120014) ----------
reset role;
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, start_date, updated_at) values
  ('a0000000-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'Old undated', 3, null, now() - interval '19 months'),
  ('a0000000-0000-4000-8000-0000000000e2', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'Old edit, future trip', 3, current_date + 30, now() - interval '19 months'),
  ('a0000000-0000-4000-8000-0000000000e3', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'Ended long ago', 3, (current_date - interval '20 months')::date, now() - interval '20 months'),
  ('a0000000-0000-4000-8000-0000000000e4', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'Ended 17 months ago', 3, (current_date - interval '17 months')::date, now() - interval '19 months');
select is(private.purge_expired_trips(), 2, 'purge deletes the two expired trips');
select is((select array_agg(dest_name order by dest_name) from public.trips where id::text like 'a0000000-0000-4000-8000-0000000000e%'),
  array['Ended 17 months ago', 'Old edit, future trip'], 'trips with a recent end date or a future trip are kept');
select ok(exists (select 1 from public.app_events where event = 'trips.purged' and props ->> 'count' = '2'), 'purge logs an app_event with the count only');
select ok(exists (select 1 from cron.job where jobname = 'purge-expired-trips'), 'nightly purge job is scheduled');
select ok(not has_function_privilege('authenticated', 'private.purge_expired_trips()', 'execute'), 'authenticated cannot run the purge');

-- ---------- plans / plan_versions / purge interaction (migrations 20261030120015..17) ----------
reset role;
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days) values
  ('a0000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'A plan trip', 3),
  ('bbbbbbbb-0000-4000-8000-0000000000f2', 'bbbbbbbb-0000-4000-8000-000000000002', 'freetext', 'B plan trip', 3);

insert into public.trips (id, owner_id, dest_kind, dest_name, length_days) values
  ('a0000000-0000-4000-8000-0000000000d6', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'A second plan trip', 3),
  ('a0000000-0000-4000-8000-0000000000d7', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'A trip without plan', 3);
-- plan id is not insertable by users (column grant), so the fixture plan is seeded as postgres
insert into public.plans (id, owner_id, trip_id) values
  ('a0000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000f1');

set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
insert into public.plans (trip_id) values ('a0000000-0000-4000-8000-0000000000d6');
select is((select count(*)::int from public.plans), 2, 'A created a plan for own trip (owner_id from default) and sees both plans');
select throws_ok($$insert into public.plans (trip_id) values ('a0000000-0000-4000-8000-0000000000f1')$$,
  '23505', null, 'one plan per trip (unique trip_id)');
select throws_ok($$insert into public.plans (trip_id) values ('bbbbbbbb-0000-4000-8000-0000000000f2')$$,
  '23503', null, 'A cannot create a plan for B trip (composite FK)');
select throws_ok($$insert into public.plans (trip_id, latest_version) values ('a0000000-0000-4000-8000-0000000000f1', 5)$$,
  '42501', null, 'latest_version is not insertable');

insert into public.plan_versions (plan_id, kind, plan, input, input_hash) values
  ('a0000000-0000-4000-8000-0000000000c1', 'generate', '{"v":1}', '{"llm":{}}', repeat('a', 64)),
  ('a0000000-0000-4000-8000-0000000000c1', 'patch',    '{"v":1}', '{"llm":{}}', repeat('a', 64)),
  ('a0000000-0000-4000-8000-0000000000c1', 'edit',     '{"v":1}', '{"llm":{}}', repeat('a', 64));
select is((select array_agg(version_no order by version_no) from public.plan_versions), array[1, 2, 3], 'trigger assigns version_no 1, 2, 3');
select is((select latest_version from public.plans where id = 'a0000000-0000-4000-8000-0000000000c1'), 3, 'plans.latest_version follows the trigger');
select throws_ok($$insert into public.plan_versions (plan_id, version_no, kind, plan, input, input_hash) values ('a0000000-0000-4000-8000-0000000000c1', 9, 'generate', '{}', '{}', repeat('a', 64))$$,
  '42501', null, 'version_no is not insertable');
select throws_ok($$insert into public.plan_versions (plan_id, kind, plan, input, input_hash) values ('a0000000-0000-4000-8000-0000000000c1', 'generate', '{}', '{}', 'nothex')$$,
  '23514', null, 'input_hash must be 64 hex chars');
select throws_ok($$insert into public.plan_versions (plan_id, kind, plan, input, input_hash) values ('a0000000-0000-4000-8000-0000000000c1', 'bogus', '{}', '{}', repeat('a', 64))$$,
  '23514', null, 'kind is restricted');
select throws_ok($$update public.plan_versions set kind = 'edit'$$, '42501', null, 'plan_versions are immutable (no update grant)');
select throws_ok($$update public.plans set latest_version = 99 where id = 'a0000000-0000-4000-8000-0000000000c1'$$,
  '42501', null, 'plans: latest_version not updatable');
with u as (update public.plans set busy_until = now() + interval '5 minutes' where id = 'a0000000-0000-4000-8000-0000000000c1' returning 1)
select is((select count(*)::int from u), 1, 'plans: busy_until updatable (lock)');

-- user B cannot see or touch A's plan
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*)::int from public.plans), 0, 'B sees no plans of A');
select is((select count(*)::int from public.plan_versions), 0, 'B sees no plan_versions of A');
select throws_ok($$insert into public.plan_versions (plan_id, kind, plan, input, input_hash) values ('a0000000-0000-4000-8000-0000000000c1', 'generate', '{}', '{}', repeat('b', 64))$$,
  '23503', null, 'B cannot add a version to A plan');
select throws_ok($$insert into public.plans (trip_id) values ('a0000000-0000-4000-8000-0000000000d7')$$,
  '23503', null, 'B cannot create a plan for A trip');
with u as (update public.plans set busy_until = null where id = 'a0000000-0000-4000-8000-0000000000c1' returning 1)
select is((select count(*)::int from u), 0, 'B cannot update A plan');
with d as (delete from public.plan_versions where plan_id = 'a0000000-0000-4000-8000-0000000000c1' returning 1)
select is((select count(*)::int from d), 0, 'B cannot delete A versions');
with d as (delete from public.plans where id = 'a0000000-0000-4000-8000-0000000000c1' returning 1)
select is((select count(*)::int from d), 0, 'B cannot delete A plan');

set local role anon;
select throws_ok($$select 1 from public.plans$$, '42501', null, 'anon cannot read plans');
select throws_ok($$select 1 from public.plan_versions$$, '42501', null, 'anon cannot read plan_versions');
select throws_ok($$select 1 from public.ai_usage$$, '42501', null, 'anon cannot read ai_usage');

-- A can prune own old versions (delete policy)
reset role;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.plan_versions where version_no <= 1 returning 1)
select is((select count(*)::int from d), 1, 'A can prune own versions');

-- cascade: trip delete removes plan and versions
reset role;
delete from public.trips where id = 'a0000000-0000-4000-8000-0000000000f1';
select is((select count(*)::int from public.plans where id = 'a0000000-0000-4000-8000-0000000000c1'), 0, 'trip delete cascades to plans');
select is((select count(*)::int from public.plan_versions where plan_id = 'a0000000-0000-4000-8000-0000000000c1'), 0, 'trip delete cascades to plan_versions');

-- purge: plan activity keeps an old trip alive; an old plan does not
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, updated_at) values
  ('a0000000-0000-4000-8000-0000000000f3', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'Old trip, fresh plan', 3, now() - interval '19 months'),
  ('a0000000-0000-4000-8000-0000000000f4', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'Old trip, old plan', 3, now() - interval '19 months'),
  ('a0000000-0000-4000-8000-0000000000f5', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'Old trip, no plan', 3, now() - interval '19 months');
insert into public.plans (id, owner_id, trip_id, updated_at) values
  ('a0000000-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000f3', now()),
  ('a0000000-0000-4000-8000-0000000000c4', 'aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000f4', now() - interval '19 months');
select is(private.purge_expired_trips(), 2, 'purge deletes old trips whose plan is old or missing');
select is((select array_agg(dest_name) from public.trips where id::text like 'a0000000-0000-4000-8000-0000000000f%'),
  array['Old trip, fresh plan'], 'a recently updated plan keeps its trip');
select is((select count(*)::int from public.plans where id = 'a0000000-0000-4000-8000-0000000000c4'), 0, 'purge cascades to the plan of an expired trip');

-- ---------- ai_usage ----------
insert into public.ai_usage (user_id, task, model, status, cost_micro_usd) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'plan_generate', 'claude-sonnet-5-5', 'ok', 90000),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'purpose_tags', 'claude-haiku-5-5', 'ok', 400),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'plan_patch', 'claude-sonnet-5-5', 'error', 0),
  (null, 'plan_generate', 'claude-sonnet-5-5', 'ok', 1);
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.ai_usage), 2, 'owner sees only own ai_usage rows');
select throws_ok($$insert into public.ai_usage (user_id, task, model, status) values ('aaaaaaaa-0000-4000-8000-000000000001', 'plan_patch', 'claude-sonnet-5-5', 'ok')$$,
  '42501', null, 'authenticated cannot insert ai_usage');
select throws_ok($$update public.ai_usage set cost_micro_usd = 0$$, '42501', null, 'authenticated cannot update ai_usage');
select throws_ok($$delete from public.ai_usage$$, '42501', null, 'authenticated cannot delete ai_usage');
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*)::int from public.ai_usage), 1, 'B sees only own ai_usage rows');
set local request.jwt.claims = '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}';
select is((select count(*)::int from public.ai_usage), 4, 'admin sees all ai_usage rows (aggregates)');
reset role;

-- ---------- ai_spend_micro_usd (budget sums) ----------
select is((select user_spent from public.ai_spend_micro_usd('aaaaaaaa-0000-4000-8000-000000000001', now() - interval '1 hour')), 90400::bigint, 'ai_spend: user sum');
select is((select global_spent from public.ai_spend_micro_usd('aaaaaaaa-0000-4000-8000-000000000001', now() - interval '1 hour')), 90401::bigint, 'ai_spend: global sum');
select is((select global_spent from public.ai_spend_micro_usd('aaaaaaaa-0000-4000-8000-000000000001', now() + interval '1 hour')), 0::bigint, 'ai_spend: window excludes older rows');
set local role authenticated;
select throws_ok($$select * from public.ai_spend_micro_usd('aaaaaaaa-0000-4000-8000-000000000001', now())$$, '42501', null, 'authenticated cannot execute ai_spend_micro_usd');
reset role;
set local role anon;
select throws_ok($$select * from public.ai_spend_micro_usd('aaaaaaaa-0000-4000-8000-000000000001', now())$$, '42501', null, 'anon cannot execute ai_spend_micro_usd');
reset role;
set local role service_role;
select lives_ok($$select * from public.ai_spend_micro_usd('aaaaaaaa-0000-4000-8000-000000000001', now())$$, 'service_role can execute ai_spend_micro_usd');
reset role;

-- ---------- phase 5: trip_items, share_links, open_done, retention (migrations 20261031120019..21) ----------
reset role;
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days) values
  ('a0000000-0000-4000-8000-000000000501', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'A item trip', 3),
  ('bbbbbbbb-0000-4000-8000-000000000502', 'bbbbbbbb-0000-4000-8000-000000000002', 'freetext', 'B item trip', 3);
insert into public.plans (id, owner_id, trip_id) values
  ('a0000000-0000-4000-8000-000000000511', 'aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000501');
insert into public.trip_items (id, owner_id, trip_id, category, title) values
  ('a0000000-0000-4000-8000-000000000521', 'aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000501', 'stay', 'A hotel');
insert into public.share_links (id, owner_id, trip_id, token_hash, label) values
  ('a0000000-0000-4000-8000-000000000531', 'aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000501', repeat('a', 64), 'A link');

-- anon: nothing
set local role anon;
select throws_ok($$select count(*) from public.trip_items$$, '42501', null, 'anon has no privileges on trip_items');
select throws_ok($$select count(*) from public.share_links$$, '42501', null, 'anon has no privileges on share_links');
reset role;

-- user B: no access to A's rows
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trip_items), 0, 'B sees no items of A');
select is((select count(*)::int from public.share_links), 0, 'B sees no share links of A');
with u as (update public.trip_items set title = 'pwned' where id = 'a0000000-0000-4000-8000-000000000521' returning 1)
select is((select count(*)::int from u), 0, 'B cannot update A item');
with d as (delete from public.trip_items where id = 'a0000000-0000-4000-8000-000000000521' returning 1)
select is((select count(*)::int from d), 0, 'B cannot delete A item');
with d as (delete from public.share_links where id = 'a0000000-0000-4000-8000-000000000531' returning 1)
select is((select count(*)::int from d), 0, 'B cannot revoke A link');
select throws_ok($$insert into public.trip_items (trip_id, category, title) values ('a0000000-0000-4000-8000-000000000501', 'stay', 'x')$$,
  '23503', null, 'B cannot add an item to A trip (composite FK)');
select throws_ok($$insert into public.share_links (trip_id, token_hash) values ('a0000000-0000-4000-8000-000000000501', repeat('b', 64))$$,
  '23503', null, 'B cannot link A trip (composite FK)');
select throws_ok($$insert into public.trip_items (owner_id, trip_id, category, title) values ('aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000501', 'stay', 'x')$$,
  '42501', null, 'owner_id is not insertable on trip_items');
reset role;

-- user A: owner path, checks, protected columns
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trip_items), 1, 'A sees own item');
select lives_ok($$insert into public.trip_items (trip_id, category, title, status, price_cents, currency, url)
  values ('a0000000-0000-4000-8000-000000000501', 'activity', 'Golf', 'booked', 9500, 'EUR', 'https://x.test/a')$$, 'A can add an item');
select lives_ok($$update public.trip_items set status = 'planned', price_cents = 100 where title = 'Golf'$$, 'A can update an item');
select throws_ok($$update public.trip_items set owner_id = 'bbbbbbbb-0000-4000-8000-000000000002' where title = 'Golf'$$, '42501', null, 'owner_id not updatable');
select throws_ok($$update public.trip_items set trip_id = 'a0000000-0000-4000-8000-0000000000f1' where title = 'Golf'$$, '42501', null, 'trip_id not updatable');
select throws_ok($$insert into public.trip_items (trip_id, category, title, currency) values ('a0000000-0000-4000-8000-000000000501', 'other', 'x', 'eur')$$, '23514', null, 'bad currency rejected');
select throws_ok($$insert into public.trip_items (trip_id, category, title, url) values ('a0000000-0000-4000-8000-000000000501', 'other', 'x', 'javascript:alert(1)')$$, '23514', null, 'bad url rejected');
select throws_ok($$insert into public.trip_items (trip_id, category, title, status) values ('a0000000-0000-4000-8000-000000000501', 'other', 'x', 'done')$$, '23514', null, 'bad status rejected');
select throws_ok($$insert into public.trip_items (trip_id, category, title, price_cents) values ('a0000000-0000-4000-8000-000000000501', 'other', 'x', -1)$$, '23514', null, 'negative price rejected');
-- item times (migration 20261101120023)
select lives_ok($$insert into public.trip_items (trip_id, category, title, status, day, start_time, end_time)
  values ('a0000000-0000-4000-8000-000000000501', 'flight', 'LH 1150 FRA → AGP', 'booked', 1, '07:50', '10:40')$$, 'A can add an item with start/end time');
select lives_ok($$update public.trip_items set start_time = '23:10', end_time = '01:20' where title = 'LH 1150 FRA → AGP'$$, 'end before start is allowed (crosses midnight)');
select lives_ok($$update public.trip_items set start_time = null, end_time = null where title = 'LH 1150 FRA → AGP'$$, 'times can be cleared');
select throws_ok($$insert into public.trip_items (trip_id, category, title, start_time) values ('a0000000-0000-4000-8000-000000000501', 'other', 'x', '24:00')$$, '23514', null, 'bad start_time rejected');
select throws_ok($$insert into public.trip_items (trip_id, category, title, start_time) values ('a0000000-0000-4000-8000-000000000501', 'other', 'x', '7:50')$$, '23514', null, 'start_time must be HH:MM');
select throws_ok($$insert into public.trip_items (trip_id, category, title, start_time, end_time) values ('a0000000-0000-4000-8000-000000000501', 'other', 'x', '10:00', '10:60')$$, '23514', null, 'bad end_time rejected');
select throws_ok($$insert into public.trip_items (trip_id, category, title, end_time) values ('a0000000-0000-4000-8000-000000000501', 'other', 'x', '10:00')$$, '23514', null, 'end_time needs start_time');

-- share_links: token_hash unreadable, no update, owner select/insert/delete
select is((select count(*)::int from public.share_links), 1, 'A sees own link (non-secret columns)');
select lives_ok($$select id, label, include_items, include_item_notes, expires_at, view_count from public.share_links$$, 'A can read the granted columns');
select throws_ok($$select token_hash from public.share_links$$, '42501', null, 'token_hash is not readable by authenticated');
select throws_ok($$update public.share_links set label = 'x'$$, '42501', null, 'share_links has no update privilege');
select throws_ok($$update public.share_links set view_count = 99$$, '42501', null, 'view_count not writable by users');
select lives_ok($$insert into public.share_links (trip_id, token_hash, label, include_items, include_item_notes, expires_at)
  values ('a0000000-0000-4000-8000-000000000501', repeat('c', 64), 'Ben', true, true, now() + interval '7 days')$$, 'A can create a link');
select throws_ok($$insert into public.share_links (trip_id, token_hash) values ('a0000000-0000-4000-8000-000000000501', 'not-hex')$$, '23514', null, 'token_hash must be sha256 hex');
select throws_ok($$insert into public.share_links (trip_id, token_hash, include_items, include_item_notes)
  values ('a0000000-0000-4000-8000-000000000501', repeat('d', 64), false, true)$$, '23514', null, 'item notes require items');
select throws_ok($$insert into public.share_links (trip_id, token_hash, expires_at)
  values ('a0000000-0000-4000-8000-000000000501', repeat('e', 64), now() - interval '1 day')$$, '23514', null, 'expiry must be after creation');
select throws_ok($$insert into public.share_links (trip_id, token_hash) values ('a0000000-0000-4000-8000-000000000501', repeat('c', 64))$$, '23505', null, 'token_hash is unique');
with d as (delete from public.share_links where label = 'Ben' returning 1)
select is((select count(*)::int from d), 1, 'A can revoke (delete) a link');

-- plans.open_done
select lives_ok($$update public.plans set open_done = '{abcd1234}' where id = 'a0000000-0000-4000-8000-000000000511'$$, 'owner can update open_done');
select throws_ok($$update public.plans set latest_version = 5 where id = 'a0000000-0000-4000-8000-000000000511'$$, '42501', null, 'latest_version still not updatable');
select throws_ok($$update public.plans set open_done = (select array_agg(g::text) from generate_series(1, 51) g) where id = 'a0000000-0000-4000-8000-000000000511'$$, '23514', null, 'open_done max 50');
reset role;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;
with u as (update public.plans set open_done = '{deadbeef}' where id = 'a0000000-0000-4000-8000-000000000511' returning 1)
select is((select count(*)::int from u), 0, 'B cannot update A open_done');
reset role;

-- demo account cannot create share links (policy), items stay allowed
update public.profiles set is_demo = true where id = 'bbbbbbbb-0000-4000-8000-000000000002';
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;
select throws_ok($$insert into public.share_links (trip_id, token_hash) values ('bbbbbbbb-0000-4000-8000-000000000502', repeat('f', 64))$$,
  '42501', null, 'demo profile cannot create a share link (RLS)');
select lives_ok($$insert into public.trip_items (trip_id, category, title) values ('bbbbbbbb-0000-4000-8000-000000000502', 'stay', 'demo item')$$, 'demo profile can add items');
reset role;
update public.profiles set is_demo = false where id = 'bbbbbbbb-0000-4000-8000-000000000002';

-- share_link_touch: server only
set local role authenticated;
select throws_ok($$select public.share_link_touch('a0000000-0000-4000-8000-000000000531')$$, '42501', null, 'authenticated cannot execute share_link_touch');
reset role;
set local role anon;
select throws_ok($$select public.share_link_touch('a0000000-0000-4000-8000-000000000531')$$, '42501', null, 'anon cannot execute share_link_touch');
reset role;
set local role service_role;
select lives_ok($$select public.share_link_touch('a0000000-0000-4000-8000-000000000531')$$, 'service_role can execute share_link_touch');
reset role;
select is((select view_count from public.share_links where id = 'a0000000-0000-4000-8000-000000000531'), 1, 'touch increments view_count');
select isnt((select last_viewed_at from public.share_links where id = 'a0000000-0000-4000-8000-000000000531'), null, 'touch sets last_viewed_at');

-- cascades: trip delete removes items and links
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days) values
  ('a0000000-0000-4000-8000-000000000541', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'Cascade trip', 3);
insert into public.trip_items (owner_id, trip_id, category, title) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000541', 'stay', 'cascade item');
insert into public.share_links (owner_id, trip_id, token_hash) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000541', repeat('9', 64));
delete from public.trips where id = 'a0000000-0000-4000-8000-000000000541';
select is((select count(*)::int from public.trip_items where trip_id = 'a0000000-0000-4000-8000-000000000541'), 0, 'trip delete cascades items');
select is((select count(*)::int from public.share_links where trip_id = 'a0000000-0000-4000-8000-000000000541'), 0, 'trip delete cascades share links');

-- retention: item activity keeps an old trip alive; otherwise purge removes trip, items and links
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, start_date, updated_at) values
  ('a0000000-0000-4000-8000-000000000551', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'Old, fresh item', 3, null, now() - interval '19 months'),
  ('a0000000-0000-4000-8000-000000000552', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'Old, old item', 3, null, now() - interval '19 months');
insert into public.trip_items (owner_id, trip_id, category, title, updated_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000551', 'stay', 'fresh', now()),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000552', 'stay', 'stale', now() - interval '19 months');
insert into public.share_links (owner_id, trip_id, token_hash) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000551', repeat('7', 64)),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000552', repeat('8', 64));
select lives_ok($$select private.purge_expired_trips()$$, 'purge runs');
select ok(exists (select 1 from public.trips where id = 'a0000000-0000-4000-8000-000000000551'), 'purge keeps an old trip with a recently updated item');
select ok(not exists (select 1 from public.trips where id = 'a0000000-0000-4000-8000-000000000552'), 'purge deletes an old trip without item activity');
select is((select count(*)::int from public.trip_items where trip_id = 'a0000000-0000-4000-8000-000000000552'), 0, 'purge removes the items');
select is((select count(*)::int from public.share_links where trip_id = 'a0000000-0000-4000-8000-000000000552'), 0, 'purge removes the share links');
select is((select count(*)::int from public.share_links where trip_id = 'a0000000-0000-4000-8000-000000000551'), 1, 'purge keeps links of kept trips');

-- item cap: 100 per trip enforced by trigger
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days) values
  ('a0000000-0000-4000-8000-000000000561', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'Cap', 3);
insert into public.trip_items (owner_id, trip_id, category, title)
  select 'aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000561', 'stay', 'i' || g from generate_series(1, 100) g;
select throws_ok($$insert into public.trip_items (owner_id, trip_id, category, title) values ('aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000561', 'stay', 'x')$$, 'TP100', null, '101st item per trip is rejected');

-- ---------- group text (migration 20261101120024) ----------
reset role;
set local request.jwt.claims = '';
insert into public.travel_groups (id, owner_id, name) values
  ('a0000000-0000-4000-8000-000000000091', 'aaaaaaaa-0000-4000-8000-000000000001', 'A text group');
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days) values
  ('a0000000-0000-4000-8000-000000000092', 'aaaaaaaa-0000-4000-8000-000000000001', 'freetext', 'Texttown', 3);
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
select lives_ok($$update public.travel_groups set description = 'Wir sind 5 Freunde' where id = 'a0000000-0000-4000-8000-000000000091'$$, 'owner can set the group description');
select throws_ok($$update public.travel_groups set description = repeat('a', 1001) where id = 'a0000000-0000-4000-8000-000000000091'$$, '23514', null, 'group description over 1000 chars rejected');
select throws_ok($$update public.travel_groups set parsed_structure = '{}' where id = 'a0000000-0000-4000-8000-000000000091'$$, '42501', null, 'owner cannot write parsed_structure');
select throws_ok($$update public.travel_groups set parsed_hash = 'h' where id = 'a0000000-0000-4000-8000-000000000091'$$, '42501', null, 'owner cannot write parsed_hash');
select throws_ok($$insert into public.travel_groups (name, parsed_hash) values ('x', 'h')$$, '42501', null, 'owner cannot insert parsed_hash');
select lives_ok($$select public.replace_group_entries('a0000000-0000-4000-8000-000000000091', '{"name":"A text group","description":"Ich und Ben","trait_keys":[]}'::jsonb, '[]'::jsonb)$$, 'replace_group_entries sets the description');
select is((select description from public.travel_groups where id = 'a0000000-0000-4000-8000-000000000091'), 'Ich und Ben', 'description updated by replace_group_entries');
select lives_ok($$select public.replace_group_entries('a0000000-0000-4000-8000-000000000091', '{"name":"A text group","trait_keys":[]}'::jsonb, '[]'::jsonb)$$, 'replace_group_entries without a description key');
select is((select description from public.travel_groups where id = 'a0000000-0000-4000-8000-000000000091'), 'Ich und Ben', 'missing description key keeps the stored description');
select lives_ok($$select public.replace_group_entries('a0000000-0000-4000-8000-000000000091', '{"name":"A text group","description":null,"trait_keys":[]}'::jsonb, '[]'::jsonb)$$, 'replace_group_entries with description null');
select is((select description from public.travel_groups where id = 'a0000000-0000-4000-8000-000000000091'), null, 'description null clears the text');

-- trips: one-off group text, exclusive with a saved group
select lives_ok($$update public.trips set group_text = 'Ich und Ben, ähnliches Alter', group_structure = '[{"count":2,"age":{"ageMode":"relativeToMe"}}]'::jsonb where id = 'a0000000-0000-4000-8000-000000000092'$$, 'owner can set group_text and group_structure');
select throws_ok($$update public.trips set group_id = 'a0000000-0000-4000-8000-000000000091' where id = 'a0000000-0000-4000-8000-000000000092'$$, '23514', null, 'saved group and one-off text are mutually exclusive');
select lives_ok($$update public.trips set group_text = null, group_structure = null, group_id = 'a0000000-0000-4000-8000-000000000091' where id = 'a0000000-0000-4000-8000-000000000092'$$, 'switching from one-off text to a saved group works');
select throws_ok($$update public.trips set group_text = 'x' where id = 'a0000000-0000-4000-8000-000000000092'$$, '23514', null, 'one-off text with a saved group is rejected');
select lives_ok($$update public.trips set group_id = null, group_text = 'x', group_structure = null where id = 'a0000000-0000-4000-8000-000000000092'$$, 'back to a one-off text');
select throws_ok($$update public.trips set group_text = null, group_structure = '[]'::jsonb where id = 'a0000000-0000-4000-8000-000000000092'$$, '23514', null, 'a structure needs a text');
select throws_ok($$update public.trips set group_structure = '{}'::jsonb where id = 'a0000000-0000-4000-8000-000000000092'$$, '23514', null, 'group_structure must be an array');
select throws_ok($$update public.trips set group_text = repeat('a', 1001) where id = 'a0000000-0000-4000-8000-000000000092'$$, '23514', null, 'group_text over 1000 chars rejected');
select throws_ok($$update public.trips set group_parsed = '{}' where id = 'a0000000-0000-4000-8000-000000000092'$$, '42501', null, 'owner cannot write group_parsed');
select throws_ok($$update public.trips set group_parsed_hash = 'h' where id = 'a0000000-0000-4000-8000-000000000092'$$, '42501', null, 'owner cannot write group_parsed_hash');
select lives_ok($$insert into public.trips (dest_kind, dest_name, length_days, group_text) values ('freetext', 'X', 2, 'nur ich')$$, 'owner can insert a trip with a one-off group text');

set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*)::int from public.trips where group_text is not null), 0, 'B does not see the one-off group text of A');
with u as (update public.travel_groups set description = 'pwn' where id = 'a0000000-0000-4000-8000-000000000091' returning 1)
select is((select count(*)::int from u), 0, 'B cannot update the description of A group');

reset role;
select ok(has_column_privilege('authenticated', 'public.travel_groups', 'description', 'update'), 'authenticated: can update description');
select ok(not has_column_privilege('authenticated', 'public.travel_groups', 'parsed_structure', 'update'), 'authenticated: cannot update parsed_structure');
select ok(not has_column_privilege('authenticated', 'public.travel_groups', 'parsed_structure', 'insert'), 'authenticated: cannot insert parsed_structure');
select ok(has_column_privilege('authenticated', 'public.trips', 'group_text', 'insert'), 'authenticated: can insert trips.group_text');
select ok(not has_column_privilege('authenticated', 'public.trips', 'group_parsed', 'update'), 'authenticated: cannot update trips.group_parsed');
select lives_ok($$insert into public.ai_usage (user_id, task, model, status) values ('aaaaaaaa-0000-4000-8000-000000000001', 'group_parse', 'claude-haiku-5-5', 'ok')$$, 'ai_usage accepts the group_parse task');
select throws_ok($$insert into public.ai_usage (user_id, task, model, status) values ('aaaaaaaa-0000-4000-8000-000000000001', 'bogus', 'claude-haiku-5-5', 'ok')$$, '23514', null, 'ai_usage still rejects unknown tasks');

-- ---------- phase 6: admin aggregate functions (migration 20261102120025) ----------
reset role;
select ok(not has_function_privilege('anon', 'public.admin_user_stats(timestamptz,timestamptz)', 'execute'), 'anon cannot execute admin_user_stats');
select ok(not has_function_privilege('authenticated', 'public.admin_user_stats(timestamptz,timestamptz)', 'execute'), 'authenticated cannot execute admin_user_stats');
select ok(not has_function_privilege('authenticated', 'public.admin_usage_stats(timestamptz,integer)', 'execute'), 'authenticated cannot execute admin_usage_stats');
select ok(not has_function_privilege('authenticated', 'public.admin_ai_stats(timestamptz,timestamptz)', 'execute'), 'authenticated cannot execute admin_ai_stats');
select ok(not has_function_privilege('authenticated', 'public.admin_api_stats(timestamptz,timestamptz)', 'execute'), 'authenticated cannot execute admin_api_stats');
select ok(not has_function_privilege('authenticated', 'public.admin_recent_events(integer)', 'execute'), 'authenticated cannot execute admin_recent_events');
select ok(not has_function_privilege('anon', 'public.admin_recent_events(integer)', 'execute'), 'anon cannot execute admin_recent_events');
select ok(has_function_privilege('service_role', 'public.admin_user_stats(timestamptz,timestamptz)', 'execute'), 'service_role can execute admin_user_stats');
select ok(has_function_privilege('service_role', 'public.admin_usage_stats(timestamptz,integer)', 'execute'), 'service_role can execute admin_usage_stats');
select ok(has_function_privilege('service_role', 'public.admin_ai_stats(timestamptz,timestamptz)', 'execute'), 'service_role can execute admin_ai_stats');
select ok(has_function_privilege('service_role', 'public.admin_api_stats(timestamptz,timestamptz)', 'execute'), 'service_role can execute admin_api_stats');
select ok(has_function_privilege('service_role', 'public.admin_recent_events(integer)', 'execute'), 'service_role can execute admin_recent_events');

set local request.jwt.claims = '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select public.admin_ai_stats(now(), now())$$, '42501', null, 'even an admin user cannot call the aggregates through the user session');
select throws_ok($$select public.admin_user_stats(now(), now())$$, '42501', null, 'admin user session cannot call admin_user_stats');
reset role;

-- shape of the results (as postgres, which is what service_role effectively is for these queries)
insert into public.app_events (created_at, level, event, route, props, user_id) values
  (now() + interval '1 hour', 'error', 'test.boom', '/api/x', '{"reason":"timeout","tripId":"t1"}', 'aaaaaaaa-0000-4000-8000-000000000001');
select is(public.admin_recent_events(5) -> 0 ->> 'event', 'test.boom', 'recent events: newest first');
select is(public.admin_recent_events(5) -> 0 ->> 'code', 'timeout', 'recent events: code comes from props.reason');
select ok(not (public.admin_recent_events(5) -> 0) ?| array['user_id', 'props', 'request_id'], 'recent events carry no user id, props or request id');
select ok((public.admin_user_stats(now(), date_trunc('month', now())) ->> 'total')::int >= 3, 'user stats: total counts the fixture users');
select ok((public.admin_user_stats(now(), date_trunc('month', now())) ->> 'active7')::int >= 1, 'user stats: an event of their own makes a user active');
select ok(jsonb_array_length(public.admin_usage_stats(date_trunc('month', now()), 14) -> 'perDay') = 14, 'usage stats: 14 day buckets');
insert into public.api_calls (provider, endpoint, cache, ok, status, latency_ms, variant) values
  ('overpass', 'interpreter', 'miss', true, 200, 1200, 'overpass-api.de'),
  ('overpass', 'interpreter', 'miss', false, 429, null, 'overpass-api.de'),
  ('overpass', 'interpreter', 'hit', true, null, null, null);
select is((select (v ->> 'calls')::int from jsonb_array_elements(public.admin_api_stats(date_trunc('day', now()), date_trunc('month', now())) -> 'overpassVariants') v where v ->> 'variant' = 'overpass-api.de'), 2, 'api stats: overpass variant counts network calls only (hit excluded)');
select is((select (v ->> 'errors')::int from jsonb_array_elements(public.admin_api_stats(date_trunc('day', now()), date_trunc('month', now())) -> 'overpassVariants') v where v ->> 'variant' = 'overpass-api.de'), 1, 'api stats: overpass variant counts errors');
select ok(public.admin_ai_stats(date_trunc('day', now()), date_trunc('month', now())) ? 'byTask', 'ai stats: has byTask');
select throws_ok($$insert into public.api_calls (provider, endpoint, cache, ok, variant) values ('overpass', 'x', 'miss', true, 'Bad Host!')$$, '23514', null, 'api_calls.variant is constrained');

-- ---------- phase 6 hardening: app_settings (migration 20261102120026) ----------
reset role;
select ok((select relrowsecurity from pg_class where oid = 'public.app_settings'::regclass), 'RLS enabled on app_settings');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'app_settings'), 0, 'app_settings has no policies');
select ok(not has_table_privilege('anon', 'public.app_settings', 'select'), 'anon has no select on app_settings');
select ok(not has_table_privilege('authenticated', 'public.app_settings', 'select'), 'authenticated has no select on app_settings');
select ok(not has_table_privilege('authenticated', 'public.app_settings', 'insert'), 'authenticated has no insert on app_settings');
select ok(not has_table_privilege('authenticated', 'public.app_settings', 'update'), 'authenticated has no update on app_settings');
select ok(not has_table_privilege('authenticated', 'public.app_settings', 'delete'), 'authenticated has no delete on app_settings');
select ok(has_table_privilege('service_role', 'public.app_settings', 'select'), 'service_role can select app_settings');
select ok(has_table_privilege('service_role', 'public.app_settings', 'insert'), 'service_role can insert app_settings');
insert into public.app_settings (key, value) values ('ai_enabled', 'true'::jsonb);
select throws_ok($$insert into public.app_settings (key, value) values ('x', '"a secret string"'::jsonb)$$, '23514', null, 'values must be boolean or number (no strings, so no secrets by accident)');
select throws_ok($$insert into public.app_settings (key, value) values ('Bad Key!', '1'::jsonb)$$, '23514', null, 'key format is constrained');
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select * from public.app_settings$$, '42501', null, 'user cannot select app_settings');
select throws_ok($$insert into public.app_settings (key, value) values ('ai_user_daily_usd', '100'::jsonb)$$, '42501', null, 'user cannot insert into app_settings');
reset role;
set local request.jwt.claims = '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select * from public.app_settings$$, '42501', null, 'admin session cannot select app_settings (only the server with the secret key)');
select throws_ok($$update public.app_settings set value = 'false'::jsonb$$, '42501', null, 'admin session cannot update app_settings');
reset role;

select * from finish();
rollback;

-- TODO (separate scripts, need the HTTP stack, see e2e/):
--  * PostgREST: GET /rest/v1/profiles with the anon key returns 401/[]; /rest/v1/rpc/hook_before_user_created -> 401/403
--  * GoTrue: signInWithOtp for an unlisted email returns 403 signup_not_allowed; listed email gets mail (Inbucket)
--  * delete user via admin API -> profiles/groups/entries/purposes gone, app_events.user_id null
--  * enumerate pg_class: every relation in schema public has relrowsecurity = true (see query below)
-- select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
--  where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity;   -- must return 0 rows
