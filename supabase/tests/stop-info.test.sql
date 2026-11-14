-- pgTAP tests for city tour stop info (migration 20261119120044, docs/specs/city-tour-stop-info.md sections 4 and 12).
-- Run with `supabase test db`. One transaction, rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select * from no_plan();

-- ---------- fixtures (as postgres) ----------
insert into public.signup_allowlist (email) values ('a@stopinfo.test'), ('b@stopinfo.test');
insert into auth.users (id, email, raw_user_meta_data, aud, role) values
  ('5100000a-0000-4000-8000-0000000000a1', 'a@stopinfo.test', '{}', 'authenticated', 'authenticated'),
  ('5100000a-0000-4000-8000-0000000000b2', 'b@stopinfo.test', '{}', 'authenticated', 'authenticated');
update public.profiles set locale = 'de' where id = '5100000a-0000-4000-8000-0000000000a1';
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days) values
  ('5100000a-0000-4000-8000-00000000a201', '5100000a-0000-4000-8000-0000000000a1', 'freetext', 'Shared trip', 3);
insert into public.trip_shares (owner_id, trip_id, grantee_id, access) values
  ('5100000a-0000-4000-8000-0000000000a1', '5100000a-0000-4000-8000-00000000a201', '5100000a-0000-4000-8000-0000000000b2', 'read');
-- Points: start osm:s, places osm:p1, osm:p2, end osm:e.
insert into public.city_tours (id, owner_id, input, trip_id, trip_day, updated_at) values
  ('5100000a-0000-4000-8000-0000000071a1', '5100000a-0000-4000-8000-0000000000a1',
   '{"start":{"key":"osm:s"},"places":[{"key":"osm:p1"},{"key":"osm:p2"}],"end":{"key":"osm:e"}}',
   '5100000a-0000-4000-8000-00000000a201', 1, '2026-01-01T00:00:00Z');

-- ---------- column, size, grants ----------
select has_column('public', 'city_tours', 'stop_info', 'city_tours.stop_info exists');
select ok(not has_column_privilege('authenticated', 'public.city_tours', 'stop_info', 'update')
      and not has_column_privilege('authenticated', 'public.city_tours', 'stop_info', 'insert'), 'authenticated: no write on stop_info');
select throws_ok($$update public.city_tours set stop_info = '[]' where id = '5100000a-0000-4000-8000-0000000071a1'$$,
  '23514', null, 'stop_info must be an object');
select throws_ok($$update public.city_tours set stop_info = jsonb_build_object('x', repeat('x', 66000)) where id = '5100000a-0000-4000-8000-0000000071a1'$$,
  '23514', null, 'stop_info above 65536 bytes is refused');
update public.city_tours set stop_info = null, updated_at = '2026-01-01T00:00:00Z' where id = '5100000a-0000-4000-8000-0000000071a1';

-- ---------- helpers ----------
select is(private.tour_point_keys('{"start":{"key":"a"},"places":[{"key":"b"}],"end":"start"}'), array['a', 'b'], 'point keys: end "start" adds nothing');
select is(private.tour_point_keys('{"places":"oops"}'), '{}'::text[], 'point keys: malformed input gives none');

-- ---------- merge_stop_info ----------
select is(public.merge_stop_info('5100000a-0000-4000-8000-0000000071a1',
  '[{"key":"osm:p1","status":"ok","checkedAt":"2026-11-14T00:00:00Z","text":"A"},{"key":"osm:gone","status":"none","checkedAt":"x"}]', 'de'),
  'ok', 'merge: ok in the owner locale');
select is((select stop_info from public.city_tours where id = '5100000a-0000-4000-8000-0000000071a1'),
  '{"v":1,"locale":"de","stops":[{"key":"osm:p1","status":"ok","checkedAt":"2026-11-14T00:00:00Z","text":"A"}]}'::jsonb,
  'merge: stored with v and locale; a key that is not a tour point is dropped');
select is((select updated_at from public.city_tours where id = '5100000a-0000-4000-8000-0000000071a1'),
  '2026-01-01T00:00:00Z'::timestamptz, 'merge: updated_at unchanged');

select is(public.merge_stop_info('5100000a-0000-4000-8000-0000000071a1',
  '[{"key":"osm:p2","status":"none","checkedAt":"y"},{"key":"osm:p1","status":"ok","checkedAt":"z","text":"B"}]', 'de'), 'ok', 'second merge ok');
select is((select jsonb_path_query_array(stop_info, '$.stops[*].key') from public.city_tours where id = '5100000a-0000-4000-8000-0000000071a1'),
  '["osm:p1","osm:p2"]'::jsonb, 'merge: keeps other entries, adds new ones');
select is((select stop_info #>> '{stops,0,text}' from public.city_tours where id = '5100000a-0000-4000-8000-0000000071a1'),
  'B', 'merge: a fetched entry replaces the stored one');

select is(public.merge_stop_info('5100000a-0000-4000-8000-0000000071a1', '[{"key":"osm:s","status":"none","checkedAt":"q"}]', 'en'),
  'stale_locale', 'merge: a batch in another locale than the owner''s is discarded');
select is((select stop_info ->> 'locale' from public.city_tours where id = '5100000a-0000-4000-8000-0000000071a1'), 'de', 'stale batch wrote nothing');

update public.profiles set locale = 'en' where id = '5100000a-0000-4000-8000-0000000000a1';
select is(public.merge_stop_info('5100000a-0000-4000-8000-0000000071a1', '[{"key":"osm:s","status":"none","checkedAt":"q"}]', 'en'),
  'ok', 'merge after the owner switched to en');
select is((select stop_info from public.city_tours where id = '5100000a-0000-4000-8000-0000000071a1'),
  '{"v":1,"locale":"en","stops":[{"key":"osm:s","status":"none","checkedAt":"q"}]}'::jsonb, 'a locale change replaces the whole value');
update public.profiles set locale = 'de' where id = '5100000a-0000-4000-8000-0000000000a1';

select is(public.merge_stop_info('5100000a-0000-4000-8000-0000000071ff', '[]', 'de'), 'not_found', 'merge: unknown tour');
select throws_ok($$select public.merge_stop_info('5100000a-0000-4000-8000-0000000071a1', '{}', 'de')$$, '22023', null, 'merge: entries must be an array');

-- ---------- an input change prunes removed stops and moves updated_at ----------
select public.merge_stop_info('5100000a-0000-4000-8000-0000000071a1',
  '[{"key":"osm:p1","status":"none","checkedAt":"a"},{"key":"osm:p2","status":"none","checkedAt":"b"}]', 'de');
update public.city_tours set input = '{"places":[{"key":"osm:p1"},{"key":"osm:new"}]}' where id = '5100000a-0000-4000-8000-0000000071a1';
select is((select jsonb_path_query_array(stop_info, '$.stops[*].key') from public.city_tours where id = '5100000a-0000-4000-8000-0000000071a1'),
  '["osm:p1"]'::jsonb, 'input change drops the info of removed stops');
select ok((select updated_at > '2026-01-02' from public.city_tours where id = '5100000a-0000-4000-8000-0000000071a1'), 'input change moves updated_at');

-- ---------- functions are secret-key only; grantee read of stop_info, no write ----------
select ok(not has_function_privilege('authenticated', 'public.merge_stop_info(uuid, jsonb, text)', 'execute'), 'authenticated cannot merge');
select ok(not has_function_privilege('anon', 'public.stop_info_reserve(uuid, uuid, integer, integer, timestamptz)', 'execute'), 'anon cannot reserve');
select ok(has_function_privilege('service_role', 'public.merge_stop_info(uuid, jsonb, text)', 'execute'), 'service_role can merge');

set local request.jwt.claims = '{"sub":"5100000a-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select stop_info ->> 'locale' from public.city_tours where id = '5100000a-0000-4000-8000-0000000071a1'), 'de', 'trip grantee reads stop_info');
select throws_ok($$update public.city_tours set stop_info = null where id = '5100000a-0000-4000-8000-0000000071a1'$$, '42501', null, 'grantee cannot write stop_info');
reset role;

-- ---------- stop_info_reserve ----------
select ok((public.stop_info_reserve('5100000a-0000-4000-8000-0000000000a1', null, 2, 100, now() - interval '1 hour') ->> 'ok')::boolean, 'reserve 1 of 2');
select ok((public.stop_info_reserve('5100000a-0000-4000-8000-0000000000a1', null, 2, 100, now() - interval '1 hour') ->> 'ok')::boolean, 'reserve 2 of 2');
select is(public.stop_info_reserve('5100000a-0000-4000-8000-0000000000a1', null, 2, 100, now() - interval '1 hour') ->> 'reason', 'scope', 'third is refused (scope)');
select ok((public.stop_info_reserve('5100000a-0000-4000-8000-0000000000b2', null, 2, 100, now() - interval '1 hour') ->> 'ok')::boolean, 'another user has their own scope');
select is(public.stop_info_reserve('5100000a-0000-4000-8000-0000000000b2', null, 5, 3, now() - interval '1 hour') ->> 'reason', 'app', 'app-wide limit counts all scopes');
-- A pending slot older than 2 minutes no longer counts; a settled one does.
update public.stop_info_slots set created_at = now() - interval '5 minutes' where user_id = '5100000a-0000-4000-8000-0000000000a1';
select ok((public.stop_info_reserve('5100000a-0000-4000-8000-0000000000a1', null, 2, 100, now() - interval '1 hour') ->> 'ok')::boolean, 'dead pending slots are not counted');
select public.stop_info_settle(id) from public.stop_info_slots where user_id = '5100000a-0000-4000-8000-0000000000a1';
update public.stop_info_slots set created_at = now() - interval '5 minutes' where user_id = '5100000a-0000-4000-8000-0000000000a1';
select is(public.stop_info_reserve('5100000a-0000-4000-8000-0000000000a1', null, 3, 100, now() - interval '1 hour') ->> 'reason',
  'scope', 'settled slots keep counting, however old within the day (3 settled, limit 3)');
select throws_ok($$select public.stop_info_reserve(null, null, 1, 1, now())$$, '22023', null, 'exactly one scope is required');
select lives_ok($$select public.stop_info_release(id) from public.stop_info_slots where settled_at is null$$, 'release removes pending slots');

select * from finish();
rollback;
