-- pgTAP tests for city tours (migration 20261116120041, docs/specs/city-tour.md sections 9 and 13).
-- Run with `supabase test db`. One transaction, rolled back. now() is constant inside it, so the updated_at checks
-- insert rows with an old updated_at first (the trigger fires on update only).
-- Actors: A owner, B write grantee of A's trip, C read grantee of A's trip, D stranger.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select * from no_plan();

-- ---------- fixtures (as postgres) ----------
insert into public.signup_allowlist (email) values ('a@tours.test'), ('b@tours.test'), ('c@tours.test'), ('d@tours.test');
insert into auth.users (id, email, raw_user_meta_data, aud, role) values
  ('7c000000-0000-4000-8000-0000000000a1', 'a@tours.test', '{}', 'authenticated', 'authenticated'),
  ('7c000000-0000-4000-8000-0000000000b2', 'b@tours.test', '{}', 'authenticated', 'authenticated'),
  ('7c000000-0000-4000-8000-0000000000c3', 'c@tours.test', '{}', 'authenticated', 'authenticated'),
  ('7c000000-0000-4000-8000-0000000000d4', 'd@tours.test', '{}', 'authenticated', 'authenticated');
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days) values
  ('7c000000-0000-4000-8000-00000000a201', '7c000000-0000-4000-8000-0000000000a1', 'freetext', 'A shared trip', 5),
  ('7c000000-0000-4000-8000-00000000a202', '7c000000-0000-4000-8000-0000000000a1', 'freetext', 'A private trip', 3),
  ('7c000000-0000-4000-8000-00000000d201', '7c000000-0000-4000-8000-0000000000d4', 'freetext', 'D trip', 2);
insert into public.trip_shares (owner_id, trip_id, grantee_id, access) values
  ('7c000000-0000-4000-8000-0000000000a1', '7c000000-0000-4000-8000-00000000a201', '7c000000-0000-4000-8000-0000000000b2', 'write'),
  ('7c000000-0000-4000-8000-0000000000a1', '7c000000-0000-4000-8000-00000000a201', '7c000000-0000-4000-8000-0000000000c3', 'read');
-- t1: A, linked to the shared trip (day 2) · t2: A, standalone · t3: A, linked to the unshared trip · t4: D, standalone
insert into public.city_tours (id, owner_id, title, input, trip_id, trip_day, updated_at) values
  ('7c000000-0000-4000-8000-0000000071a1', '7c000000-0000-4000-8000-0000000000a1', 'Linked', '{"mode":"foot"}', '7c000000-0000-4000-8000-00000000a201', 2, now() - interval '1 day'),
  ('7c000000-0000-4000-8000-0000000072a1', '7c000000-0000-4000-8000-0000000000a1', 'Standalone', '{"mode":"foot"}', null, null, now() - interval '1 day'),
  ('7c000000-0000-4000-8000-0000000073a1', '7c000000-0000-4000-8000-0000000000a1', 'Private trip', '{"mode":"car"}', '7c000000-0000-4000-8000-00000000a202', 1, now() - interval '1 day'),
  ('7c000000-0000-4000-8000-0000000074d4', '7c000000-0000-4000-8000-0000000000d4', 'D tour', '{"mode":"cycling"}', null, null, now() - interval '1 day');

-- ---------- table, RLS and grants ----------
select has_table('public', 'city_tours', 'city_tours exists');
select ok((select relrowsecurity from pg_class where oid = 'public.city_tours'::regclass), 'RLS enabled on city_tours');
select ok(not has_table_privilege('anon', 'public.city_tours', 'select'), 'anon: no select on city_tours');
select ok(has_table_privilege('authenticated', 'public.city_tours', 'select') and has_table_privilege('authenticated', 'public.city_tours', 'delete'), 'authenticated: select and delete');
select ok(not has_table_privilege('authenticated', 'public.city_tours', 'insert') and not has_table_privilege('authenticated', 'public.city_tours', 'update'), 'authenticated: no table-wide insert or update');
select ok(has_column_privilege('authenticated', 'public.city_tours', 'title', 'insert')
      and has_column_privilege('authenticated', 'public.city_tours', 'input', 'insert')
      and has_column_privilege('authenticated', 'public.city_tours', 'trip_id', 'insert')
      and has_column_privilege('authenticated', 'public.city_tours', 'trip_day', 'insert'), 'authenticated: inserts title, input, trip_id, trip_day');
select ok(has_column_privilege('authenticated', 'public.city_tours', 'title', 'update')
      and has_column_privilege('authenticated', 'public.city_tours', 'input', 'update')
      and has_column_privilege('authenticated', 'public.city_tours', 'trip_id', 'update')
      and has_column_privilege('authenticated', 'public.city_tours', 'trip_day', 'update'), 'authenticated: updates title, input, trip_id, trip_day');
select ok(not has_column_privilege('authenticated', 'public.city_tours', 'result', 'update')
      and not has_column_privilege('authenticated', 'public.city_tours', 'result_hash', 'update')
      and not has_column_privilege('authenticated', 'public.city_tours', 'computed_at', 'update'), 'authenticated: cannot update result, result_hash, computed_at');
select ok(not has_column_privilege('authenticated', 'public.city_tours', 'result', 'insert')
      and not has_column_privilege('authenticated', 'public.city_tours', 'result_hash', 'insert')
      and not has_column_privilege('authenticated', 'public.city_tours', 'computed_at', 'insert'), 'authenticated: cannot insert result, result_hash, computed_at');
select ok(not has_column_privilege('authenticated', 'public.city_tours', 'owner_id', 'insert')
      and not has_column_privilege('authenticated', 'public.city_tours', 'owner_id', 'update'), 'authenticated: owner_id comes from its default only');
select ok(has_table_privilege('service_role', 'public.city_tours', 'select') and has_table_privilege('service_role', 'public.city_tours', 'insert')
      and has_table_privilege('service_role', 'public.city_tours', 'update') and has_table_privilege('service_role', 'public.city_tours', 'delete'), 'service_role: all');

-- ---------- checks (as postgres) ----------
select throws_ok($$insert into public.city_tours (owner_id, input) values ('7c000000-0000-4000-8000-0000000000a1', '[]')$$, '23514', null, 'input must be an object');
-- Exact boundary: the padding length whose measured size is 32768 (accepted) or 32769 bytes (refused). If no such
-- length exists the value is null and the insert fails with 23502, so the test cannot pass by accident.
select lives_ok($$insert into public.city_tours (owner_id, input) values ('7c000000-0000-4000-8000-0000000000a1',
  (select jsonb_build_object('x', repeat('x', n)) from generate_series(32000, 33000) n where pg_column_size(jsonb_build_object('x', repeat('x', n))) = 32768 limit 1))$$,
  'input of exactly 32768 bytes is accepted (migration 20261118120043)');
select throws_ok($$insert into public.city_tours (owner_id, input) values ('7c000000-0000-4000-8000-0000000000a1',
  (select jsonb_build_object('x', repeat('x', n)) from generate_series(32000, 33000) n where pg_column_size(jsonb_build_object('x', repeat('x', n))) = 32769 limit 1))$$,
  '23514', null, 'input of 32769 bytes is refused');
select is((select count(*)::int from pg_constraint where conrelid = 'public.city_tours'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%pg_column_size(input)%'), 1, 'exactly one input size check');
select throws_ok($$insert into public.city_tours (owner_id, input, title) values ('7c000000-0000-4000-8000-0000000000a1', '{}', repeat('t', 121))$$, '23514', null, 'title above 120 characters is refused');
select throws_ok($$insert into public.city_tours (owner_id, input, trip_id, trip_day) values ('7c000000-0000-4000-8000-0000000000a1', '{}', '7c000000-0000-4000-8000-00000000a201', 0)$$, '23514', null, 'trip_day 0 is refused');
select throws_ok($$insert into public.city_tours (owner_id, input, trip_id, trip_day) values ('7c000000-0000-4000-8000-0000000000a1', '{}', '7c000000-0000-4000-8000-00000000a201', 61)$$, '23514', null, 'trip_day 61 is refused');
select lives_ok($$insert into public.city_tours (owner_id, input, trip_id, trip_day) values ('7c000000-0000-4000-8000-0000000000a1', '{}', '7c000000-0000-4000-8000-00000000a201', 60)$$, 'trip_day 60 is accepted');
select throws_ok($$insert into public.city_tours (owner_id, input, result) values ('7c000000-0000-4000-8000-0000000000a1', '{}', '[]')$$, '23514', null, 'result must be an object');
select throws_ok($$insert into public.city_tours (owner_id, input, result) values ('7c000000-0000-4000-8000-0000000000a1', '{}', jsonb_build_object('poly', repeat('p', 270000)))$$, '23514', null, 'result above 262144 bytes is refused');
select lives_ok($$insert into public.city_tours (owner_id, input, result, result_hash, computed_at) values ('7c000000-0000-4000-8000-0000000000a1', '{}', jsonb_build_object('poly', repeat('p', 200000)), repeat('f', 64), now())$$, 'a 200 kB result with a hash is accepted');
select throws_ok($$insert into public.city_tours (owner_id, input, result_hash) values ('7c000000-0000-4000-8000-0000000000a1', '{}', 'abc')$$, '23514', null, 'result_hash must be 64 hex characters');
select throws_ok($$insert into public.city_tours (owner_id, input, result_hash) values ('7c000000-0000-4000-8000-0000000000a1', '{}', repeat('A', 64))$$, '23514', null, 'result_hash must be lower-case hex');
-- the check rows above belong to A; remove them so the counts below see only the fixtures
delete from public.city_tours
 where owner_id = '7c000000-0000-4000-8000-0000000000a1'
   and id not in ('7c000000-0000-4000-8000-0000000071a1', '7c000000-0000-4000-8000-0000000072a1', '7c000000-0000-4000-8000-0000000073a1');

-- ---------- A (owner) ----------
set local request.jwt.claims = '{"sub":"7c000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.city_tours), 3, 'A sees exactly the 3 own tours');
select is((select count(*)::int from public.city_tours where owner_id = '7c000000-0000-4000-8000-0000000000d4'), 0, 'A cannot read the tours of D');
with i as (insert into public.city_tours (title, input, trip_id, trip_day) values ('New', '{"mode":"foot"}', '7c000000-0000-4000-8000-00000000a202', 3) returning owner_id)
select is((select owner_id from i), '7c000000-0000-4000-8000-0000000000a1'::uuid, 'A inserts a tour linked to an own trip; owner_id defaults to A');
select throws_ok($$insert into public.city_tours (input, result) values ('{}', '{}')$$, '42501', null, 'A cannot insert result');
select throws_ok($$insert into public.city_tours (input, result_hash) values ('{}', repeat('a', 64))$$, '42501', null, 'A cannot insert result_hash');
select throws_ok($$insert into public.city_tours (input, computed_at) values ('{}', now())$$, '42501', null, 'A cannot insert computed_at');
select throws_ok($$insert into public.city_tours (owner_id, input) values ('7c000000-0000-4000-8000-0000000000d4', '{}')$$, '42501', null, 'A cannot insert a tour for D');
select throws_ok($$update public.city_tours set result = '{"v":1}' where id = '7c000000-0000-4000-8000-0000000072a1'$$, '42501', null, 'A cannot update result');
select throws_ok($$update public.city_tours set result_hash = repeat('a', 64) where id = '7c000000-0000-4000-8000-0000000072a1'$$, '42501', null, 'A cannot update result_hash');
select throws_ok($$update public.city_tours set computed_at = now() where id = '7c000000-0000-4000-8000-0000000072a1'$$, '42501', null, 'A cannot update computed_at');
select throws_ok($$insert into public.city_tours (input, trip_id, trip_day) values ('{}', '7c000000-0000-4000-8000-00000000d201', 1)$$, '23503', null, 'A cannot link a new tour to the trip of D (FK)');
select throws_ok($$update public.city_tours set trip_id = '7c000000-0000-4000-8000-00000000d201' where id = '7c000000-0000-4000-8000-0000000072a1'$$, '23503', null, 'A cannot link an existing tour to the trip of D (FK)');
with u as (update public.city_tours set title = 'Renamed' where id = '7c000000-0000-4000-8000-0000000072a1' returning updated_at)
select is((select updated_at from u), now(), 'A edits an own tour and the trigger moves updated_at');
with u as (update public.city_tours set title = 'Hijack' where id = '7c000000-0000-4000-8000-0000000074d4' returning 1)
select is((select count(*)::int from u), 0, 'A cannot edit the tour of D');
with d as (delete from public.city_tours where id = '7c000000-0000-4000-8000-0000000074d4' returning 1)
select is((select count(*)::int from d), 0, 'A cannot delete the tour of D');
reset role;

-- ---------- B (write grantee of the shared trip) ----------
set local request.jwt.claims = '{"sub":"7c000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.city_tours where id = '7c000000-0000-4000-8000-0000000071a1'), 1, 'B (write) reads the tour linked to the shared trip');
select is((select count(*)::int from public.city_tours), 1, 'B (write) cannot read the unlinked tours of A or the one linked to the unshared trip');
with u as (update public.city_tours set title = 'B edit' where id = '7c000000-0000-4000-8000-0000000071a1' returning 1)
select is((select count(*)::int from u), 0, 'B (write) cannot update the linked tour (read-only)');
with d as (delete from public.city_tours where id = '7c000000-0000-4000-8000-0000000071a1' returning 1)
select is((select count(*)::int from d), 0, 'B (write) cannot delete the linked tour');
select throws_ok($$insert into public.city_tours (input, trip_id, trip_day) values ('{}', '7c000000-0000-4000-8000-00000000a201', 1)$$, '23503', null, 'B cannot link an own tour to the trip of A (FK needs the same owner)');
reset role;

-- ---------- C (read grantee of the shared trip) ----------
set local request.jwt.claims = '{"sub":"7c000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select array_agg(id) from public.city_tours), array['7c000000-0000-4000-8000-0000000071a1'::uuid], 'C (read) reads only the tour linked to the shared trip');
select is((select title from public.city_tours where id = '7c000000-0000-4000-8000-0000000071a1'), 'Linked', 'B left the linked tour unchanged');
with u as (update public.city_tours set title = 'C edit' where id = '7c000000-0000-4000-8000-0000000071a1' returning 1)
select is((select count(*)::int from u), 0, 'C (read) cannot update the linked tour');
with d as (delete from public.city_tours where id = '7c000000-0000-4000-8000-0000000071a1' returning 1)
select is((select count(*)::int from d), 0, 'C (read) cannot delete the linked tour');
reset role;

-- a disabled owner hides the linked tour (private.shared_trip_ids checks private.is_active)
update public.profiles set disabled_at = now() where id = '7c000000-0000-4000-8000-0000000000a1';
set local request.jwt.claims = '{"sub":"7c000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.city_tours), 0, 'C sees no tour while A is disabled');
reset role;
update public.profiles set disabled_at = null where id = '7c000000-0000-4000-8000-0000000000a1';

-- ---------- D (stranger) ----------
set local request.jwt.claims = '{"sub":"7c000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select is((select array_agg(id) from public.city_tours), array['7c000000-0000-4000-8000-0000000074d4'::uuid], 'D sees only the own tour');
reset role;

-- ---------- trip deleted: the tour stays standalone ----------
set local request.jwt.claims = '{"sub":"7c000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.trips where id = '7c000000-0000-4000-8000-00000000a202' returning 1)
select is((select count(*)::int from d), 1, 'A deletes the private trip');
select is((select trip_id from public.city_tours where id = '7c000000-0000-4000-8000-0000000073a1'), null::uuid, 'the tour of the deleted trip stays with trip_id null');
select is((select owner_id from public.city_tours where id = '7c000000-0000-4000-8000-0000000073a1'), '7c000000-0000-4000-8000-0000000000a1'::uuid, 'and keeps its owner');
select is((select trip_day from public.city_tours where id = '7c000000-0000-4000-8000-0000000073a1'), 1::smallint, 'and keeps trip_day (ignored by code without trip_id)');
reset role;

-- unsharing hides the linked tour again
delete from public.trip_shares where trip_id = '7c000000-0000-4000-8000-00000000a201' and grantee_id = '7c000000-0000-4000-8000-0000000000c3';
set local request.jwt.claims = '{"sub":"7c000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.city_tours), 0, 'C sees no tour after the share is removed');
reset role;

-- ---------- date helper ----------
set local request.jwt.claims = '{}';
select is(private.iso_date_or_null('2026-02-28'), '2026-02-28'::date, 'iso_date_or_null: a valid date');
select is(private.iso_date_or_null('2026-02-30'), null::date, 'iso_date_or_null: an impossible date is null');
select is(private.iso_date_or_null('2026-13-01'), null::date, 'iso_date_or_null: month 13 is null');
select is(private.iso_date_or_null('0000-01-01'), null::date, 'iso_date_or_null: year 0 is null');
select is(private.iso_date_or_null('tomorrow'), null::date, 'iso_date_or_null: a keyword is null');
select is(private.iso_date_or_null('2026-1-1'), null::date, 'iso_date_or_null: a non-ISO shape is null');
select is(private.iso_date_or_null(null), null::date, 'iso_date_or_null: null is null');
select ok(not has_function_privilege('authenticated', 'private.iso_date_or_null(text)', 'execute'), 'authenticated cannot call iso_date_or_null');

-- ---------- retention: standalone tours 18 months after the later of date and last change ----------
insert into public.city_tours (id, owner_id, input, trip_id, trip_day, updated_at) values
  -- deleted: old, no date
  ('7c000000-0000-4000-8000-0000000081a1', '7c000000-0000-4000-8000-0000000000a1', '{}', null, null, now() - interval '19 months'),
  -- deleted: old, date also old
  ('7c000000-0000-4000-8000-0000000082a1', '7c000000-0000-4000-8000-0000000000a1', jsonb_build_object('date', to_char(now() - interval '2 years', 'YYYY-MM-DD')), null, null, now() - interval '19 months'),
  -- kept: old change, but the tour date is recent
  ('7c000000-0000-4000-8000-0000000083a1', '7c000000-0000-4000-8000-0000000000a1', jsonb_build_object('date', to_char(now() - interval '1 month', 'YYYY-MM-DD')), null, null, now() - interval '19 months'),
  -- kept: old, but linked to a (current) trip
  ('7c000000-0000-4000-8000-0000000084a1', '7c000000-0000-4000-8000-0000000000a1', '{}', '7c000000-0000-4000-8000-00000000a201', 1, now() - interval '19 months'),
  -- kept: recent
  ('7c000000-0000-4000-8000-0000000085a1', '7c000000-0000-4000-8000-0000000000a1', '{}', null, null, now() - interval '17 months'),
  -- deleted: old, impossible date (ignored, must not fail the purge)
  ('7c000000-0000-4000-8000-0000000086a1', '7c000000-0000-4000-8000-0000000000a1', '{"date":"2099-02-30"}', null, null, now() - interval '19 months'),
  -- deleted: old, date of the wrong type
  ('7c000000-0000-4000-8000-0000000087a1', '7c000000-0000-4000-8000-0000000000a1', '{"date":20991231}', null, null, now() - interval '19 months'),
  -- kept: recent, garbage date
  ('7c000000-0000-4000-8000-0000000088a1', '7c000000-0000-4000-8000-0000000000a1', '{"date":"9999-99-99"}', null, null, now());
select lives_ok($$select private.purge_expired_trips()$$, 'the daily purge runs with malformed tour dates');
select is((select array_agg(id order by id) from public.city_tours where id::text like '7c000000-0000-4000-8000-000000008_a1'),
          array['7c000000-0000-4000-8000-0000000083a1', '7c000000-0000-4000-8000-0000000084a1',
                '7c000000-0000-4000-8000-0000000085a1', '7c000000-0000-4000-8000-0000000088a1']::uuid[],
          'the purge deletes old standalone tours and keeps recent, future-dated and linked ones');
select is((select (props ->> 'count')::int from public.app_events where event = 'city_tours.purged' order by created_at desc limit 1), 4, 'the purge logs the count');
select is((select count(*)::int from public.trips where id = '7c000000-0000-4000-8000-00000000a201'), 1, 'the purge keeps the current trip');
select is((select count(*)::int from public.city_tours where id in ('7c000000-0000-4000-8000-0000000071a1', '7c000000-0000-4000-8000-0000000072a1', '7c000000-0000-4000-8000-0000000073a1', '7c000000-0000-4000-8000-0000000074d4')), 4, 'the purge keeps the recent fixtures');

-- a purged trip leaves its tour standalone with a fresh updated_at, so the same run does not delete it
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, updated_at) values
  ('7c000000-0000-4000-8000-00000000a203', '7c000000-0000-4000-8000-0000000000a1', 'freetext', 'Old trip', 2, now() - interval '3 years');
insert into public.city_tours (id, owner_id, input, trip_id, trip_day, updated_at) values
  ('7c000000-0000-4000-8000-0000000089a1', '7c000000-0000-4000-8000-0000000000a1', '{}', '7c000000-0000-4000-8000-00000000a203', 1, now() - interval '3 years');
select lives_ok($$select private.purge_expired_trips()$$, 'the purge runs again');
select is((select count(*)::int from public.trips where id = '7c000000-0000-4000-8000-00000000a203'), 0, 'the old trip is purged');
select is((select count(*)::int from public.city_tours where id = '7c000000-0000-4000-8000-0000000089a1'), 1, 'its tour stays');
select is((select trip_id from public.city_tours where id = '7c000000-0000-4000-8000-0000000089a1'), null::uuid, 'its tour is now standalone');

-- ---------- account deletion ----------
delete from auth.users where id = '7c000000-0000-4000-8000-0000000000a1';
select is((select count(*)::int from public.city_tours where owner_id = '7c000000-0000-4000-8000-0000000000a1'), 0, 'deleting the owner removes their tours');
select is((select count(*)::int from public.city_tours where owner_id = '7c000000-0000-4000-8000-0000000000d4'), 1, 'other users keep their tours');

select * from finish();
rollback;
