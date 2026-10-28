-- pgTAP RLS / grants tests. Run with `supabase test db` (CI job `db-test`, see .github/workflows/ci.yml).
-- Written against migrations 20261027120001..20261029120014. Runs as postgres inside one transaction that is rolled back.
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

select * from finish();
rollback;

-- TODO (separate scripts, need the HTTP stack, see e2e/):
--  * PostgREST: GET /rest/v1/profiles with the anon key returns 401/[]; /rest/v1/rpc/hook_before_user_created -> 401/403
--  * GoTrue: signInWithOtp for an unlisted email returns 403 signup_not_allowed; listed email gets mail (Inbucket)
--  * delete user via admin API -> profiles/groups/entries/purposes gone, app_events.user_id null
--  * enumerate pg_class: every relation in schema public has relrowsecurity = true (see query below)
-- select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
--  where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity;   -- must return 0 rows
