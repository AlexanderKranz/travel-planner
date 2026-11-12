-- pgTAP tests for trip stops (migration 20261114120039, docs/specs/itinerary-upload.md section 2).
-- Run with `supabase test db`. One transaction, rolled back.
-- Actors: A owner, B write grantee, C read grantee, D stranger.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select * from no_plan();

-- ---------- fixtures (as postgres) ----------
insert into public.signup_allowlist (email) values ('a@stops.test'), ('b@stops.test'), ('c@stops.test'), ('d@stops.test');
insert into auth.users (id, email, raw_user_meta_data, aud, role) values
  ('5b000000-0000-4000-8000-0000000000a1', 'a@stops.test', '{}', 'authenticated', 'authenticated'),
  ('5b000000-0000-4000-8000-0000000000b2', 'b@stops.test', '{}', 'authenticated', 'authenticated'),
  ('5b000000-0000-4000-8000-0000000000c3', 'c@stops.test', '{}', 'authenticated', 'authenticated'),
  ('5b000000-0000-4000-8000-0000000000d4', 'd@stops.test', '{}', 'authenticated', 'authenticated');
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days) values
  ('5b000000-0000-4000-8000-00000000a201', '5b000000-0000-4000-8000-0000000000a1', 'freetext', 'A trip', 5);
insert into public.trip_shares (owner_id, trip_id, grantee_id, access) values
  ('5b000000-0000-4000-8000-0000000000a1', '5b000000-0000-4000-8000-00000000a201', '5b000000-0000-4000-8000-0000000000b2', 'write'),
  ('5b000000-0000-4000-8000-0000000000a1', '5b000000-0000-4000-8000-00000000a201', '5b000000-0000-4000-8000-0000000000c3', 'read');

-- ---------- column: shape checks and grants ----------
select ok(has_column_privilege('authenticated', 'public.trips', 'stops', 'insert') and has_column_privilege('authenticated', 'public.trips', 'stops', 'update'), 'authenticated: can write trips.stops');
select ok((select stops is null from public.trips where id = '5b000000-0000-4000-8000-00000000a201'), 'stops default to null');
select throws_ok($$update public.trips set stops = '{}' where id = '5b000000-0000-4000-8000-00000000a201'$$, '23514', null, 'stops must be an array');
select throws_ok($$update public.trips set stops = (select jsonb_agg(jsonb_build_object('day', 1, 'place', 'X')) from generate_series(1, 41)) where id = '5b000000-0000-4000-8000-00000000a201'$$, '23514', null, 'more than 40 stops are refused');
select lives_ok($$update public.trips set stops = (select jsonb_agg(jsonb_build_object('day', 1, 'place', 'X')) from generate_series(1, 40)) where id = '5b000000-0000-4000-8000-00000000a201'$$, '40 stops are accepted');
update public.trips set stops = null where id = '5b000000-0000-4000-8000-00000000a201';

-- ---------- sharing: owner and write grantee edit, read grantee reads, stranger sees nothing ----------
set local request.jwt.claims = '{"sub":"5b000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
with u as (update public.trips set stops = '[{"day":1,"place":"Hafen","dep":"16:00"}]' where id = '5b000000-0000-4000-8000-00000000a201' returning 1)
select is((select count(*)::int from u), 1, 'A (owner) saves stops');
reset role;

set local request.jwt.claims = '{"sub":"5b000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select jsonb_array_length(stops) from public.trips where id = '5b000000-0000-4000-8000-00000000a201'), 1, 'B (write) reads the stops');
with u as (update public.trips set stops = '[{"day":1,"place":"Hafen"},{"day":2,"sea":true}]' where id = '5b000000-0000-4000-8000-00000000a201' returning 1)
select is((select count(*)::int from u), 1, 'B (write) edits the stops (not an owner-only column)');
reset role;

set local request.jwt.claims = '{"sub":"5b000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select jsonb_array_length(stops) from public.trips where id = '5b000000-0000-4000-8000-00000000a201'), 2, 'C (read) reads the stops');
with u as (update public.trips set stops = '[]' where id = '5b000000-0000-4000-8000-00000000a201' returning 1)
select is((select count(*)::int from u), 0, 'C (read) cannot edit the stops');
reset role;

set local request.jwt.claims = '{"sub":"5b000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.trips where id = '5b000000-0000-4000-8000-00000000a201'), 0, 'D sees no trip, so no stops');
with u as (update public.trips set stops = '[]' where id = '5b000000-0000-4000-8000-00000000a201' returning 1)
select is((select count(*)::int from u), 0, 'D cannot edit the stops');
reset role;

-- ---------- itinerary_extracts ----------
reset role;
set local request.jwt.claims = '{}';
insert into public.itinerary_extracts (owner_id, hash, stops) values
  ('5b000000-0000-4000-8000-0000000000a1', repeat('a', 64), '[{"day":1,"place":"Hafen"}]'),
  ('5b000000-0000-4000-8000-0000000000b2', repeat('b', 64), '[]');
select ok((select relrowsecurity from pg_class where oid = 'public.itinerary_extracts'::regclass), 'RLS enabled on itinerary_extracts');
select ok(not has_table_privilege('anon', 'public.itinerary_extracts', 'select'), 'anon: no select on itinerary_extracts');
select ok(has_table_privilege('authenticated', 'public.itinerary_extracts', 'select') and has_table_privilege('authenticated', 'public.itinerary_extracts', 'delete'), 'authenticated: select and delete');
select ok(not has_table_privilege('authenticated', 'public.itinerary_extracts', 'insert') and not has_table_privilege('authenticated', 'public.itinerary_extracts', 'update'), 'authenticated: no insert or update');
select ok(has_table_privilege('service_role', 'public.itinerary_extracts', 'insert') and has_table_privilege('service_role', 'public.itinerary_extracts', 'update'), 'service_role: insert and update');
select throws_ok($$insert into public.itinerary_extracts (owner_id, hash, stops) values ('5b000000-0000-4000-8000-0000000000a1', 'nothex', '[]')$$, '23514', null, 'hash must be 64 hex characters');
select throws_ok($$insert into public.itinerary_extracts (owner_id, hash, stops) values ('5b000000-0000-4000-8000-0000000000a1', repeat('a', 64), '[]')$$, '23505', null, 'one row per owner and hash');
select throws_ok($$insert into public.itinerary_extracts (owner_id, hash, stops) values ('5b000000-0000-4000-8000-0000000000a1', repeat('c', 64), '{}')$$, '23514', null, 'stops must be an array');

set local request.jwt.claims = '{"sub":"5b000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.itinerary_extracts), 1, 'A sees only own extractions');
select throws_ok($$insert into public.itinerary_extracts (owner_id, hash, stops) values ('5b000000-0000-4000-8000-0000000000a1', repeat('d', 64), '[]')$$, '42501', null, 'A cannot insert an extraction');
select throws_ok($$update public.itinerary_extracts set stops = '[]' where owner_id = '5b000000-0000-4000-8000-0000000000a1'$$, '42501', null, 'A cannot update an extraction');
with d as (delete from public.itinerary_extracts where owner_id = '5b000000-0000-4000-8000-0000000000b2' returning 1)
select is((select count(*)::int from d), 0, 'A cannot delete the extraction of B');
reset role;

set local request.jwt.claims = '{"sub":"5b000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.itinerary_extracts), 0, 'C (read grantee of the trip) sees no extraction of A');
reset role;

set local request.jwt.claims = '{"sub":"5b000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
with d as (delete from public.itinerary_extracts where owner_id = '5b000000-0000-4000-8000-0000000000a1' returning 1)
select is((select count(*)::int from d), 1, 'A deletes an own extraction');
reset role;

-- ---------- ai_usage task and retention ----------
set local request.jwt.claims = '{}';
select lives_ok($$insert into public.ai_usage (user_id, task, model, status, input_tokens) values ('5b000000-0000-4000-8000-0000000000a1', 'itinerary_extract', 'claude-haiku-5-5', 'ok', 800)$$, 'ai_usage accepts the itinerary_extract task');
update public.itinerary_extracts set created_at = now() - interval '31 days' where owner_id = '5b000000-0000-4000-8000-0000000000b2';
insert into public.itinerary_extracts (owner_id, hash, stops) values ('5b000000-0000-4000-8000-0000000000a1', repeat('e', 64), '[]');
select lives_ok($$select private.purge_expired_trips()$$, 'the daily purge runs');
select is((select count(*)::int from public.itinerary_extracts), 1, 'the purge removes extractions older than 30 days and keeps new ones');
select is((select count(*)::int from public.trips where id = '5b000000-0000-4000-8000-00000000a201'), 1, 'the purge keeps the current trip');

-- ---------- cascade ----------
delete from auth.users where id = '5b000000-0000-4000-8000-0000000000a1';
select is((select count(*)::int from public.itinerary_extracts where owner_id = '5b000000-0000-4000-8000-0000000000a1'), 0, 'deleting the owner removes their extractions');

select * from finish();
rollback;
