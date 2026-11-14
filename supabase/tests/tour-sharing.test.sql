-- pgTAP tests for sharing city tours (migration 20261120120045, docs/specs/city-tour.md 9.3 and 17.1 [P4]).
-- Run with `supabase test db`. One transaction, rolled back.
-- Actors: A tour owner, B write grantee, C read grantee, D stranger, E demo, F owner who gets disabled.
-- Share rows are created with public.share_resource as service_role, the only write path.
-- Convention: `reset role; set local request.jwt.claims = '{}'` before a postgres section,
-- `set local request.jwt.claims = '{"sub":...}'; set local role authenticated` to act as a user.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select * from no_plan();

-- ---------- fixtures (as postgres) ----------
insert into public.signup_allowlist (email) values
  ('a@tshare.test'), ('b@tshare.test'), ('c@tshare.test'), ('d@tshare.test'), ('e@tshare.test'), ('f@tshare.test');
insert into auth.users (id, email, raw_user_meta_data, aud, role) values
  ('7d000000-0000-4000-8000-0000000000a1', 'a@tshare.test', '{}', 'authenticated', 'authenticated'),
  ('7d000000-0000-4000-8000-0000000000b2', 'b@tshare.test', '{}', 'authenticated', 'authenticated'),
  ('7d000000-0000-4000-8000-0000000000c3', 'c@tshare.test', '{}', 'authenticated', 'authenticated'),
  ('7d000000-0000-4000-8000-0000000000d4', 'd@tshare.test', '{}', 'authenticated', 'authenticated'),
  ('7d000000-0000-4000-8000-0000000000e5', 'e@tshare.test', '{}', 'authenticated', 'authenticated'),
  ('7d000000-0000-4000-8000-0000000000f6', 'f@tshare.test', '{}', 'authenticated', 'authenticated');
update public.profiles set is_demo = true where id = '7d000000-0000-4000-8000-0000000000e5';
update public.profiles set display_name = 'Bob' where id = '7d000000-0000-4000-8000-0000000000b2';

insert into public.trips (id, owner_id, dest_kind, dest_name, length_days) values
  ('7d000000-0000-4000-8000-00000000a201', '7d000000-0000-4000-8000-0000000000a1', 'freetext', 'A trip', 3);
insert into public.city_tours (id, owner_id, title, input) values
  ('7d000000-0000-4000-8000-0000000071a1', '7d000000-0000-4000-8000-0000000000a1', 'A tour', '{"mode":"foot"}'),
  ('7d000000-0000-4000-8000-0000000072a1', '7d000000-0000-4000-8000-0000000000a1', 'A private tour', '{"mode":"foot"}'),
  ('7d000000-0000-4000-8000-0000000073a1', '7d000000-0000-4000-8000-0000000000a1', 'A tour to delete', '{"mode":"foot"}'),
  ('7d000000-0000-4000-8000-0000000071e5', '7d000000-0000-4000-8000-0000000000e5', 'E tour', '{"mode":"foot"}'),
  ('7d000000-0000-4000-8000-0000000071f6', '7d000000-0000-4000-8000-0000000000f6', 'F tour', '{"mode":"foot"}');

-- ---------- structure ----------
select ok((select relrowsecurity from pg_class where oid = 'public.tour_shares'::regclass), 'RLS enabled on tour_shares');
select ok(not has_table_privilege('authenticated', 'public.tour_shares', 'insert')
      and not has_table_privilege('authenticated', 'public.tour_shares', 'update'), 'authenticated: no insert or update on tour_shares');
select ok(has_table_privilege('authenticated', 'public.tour_shares', 'select')
      and has_table_privilege('authenticated', 'public.tour_shares', 'delete'), 'authenticated: select and delete on tour_shares');
select ok(not has_column_privilege('authenticated', 'public.share_links', 'tour_id', 'insert'), 'authenticated cannot insert share_links.tour_id');
select ok(has_column_privilege('authenticated', 'public.share_links', 'tour_id', 'select'), 'authenticated reads share_links.tour_id');
select ok(not has_function_privilege('authenticated', 'public.share_resource(uuid, text, uuid, uuid, text, uuid)', 'execute'), 'share_resource is not executable by authenticated');

-- ---------- share_resource for tours (as service_role) ----------
set local role service_role;
select is((select created from public.share_resource('7d000000-0000-4000-8000-0000000000a1', 'tour', '7d000000-0000-4000-8000-0000000071a1', '7d000000-0000-4000-8000-0000000000b2', 'write')), true, 'A shares the tour with B (write)');
select is((select created from public.share_resource('7d000000-0000-4000-8000-0000000000a1', 'tour', '7d000000-0000-4000-8000-0000000071a1', '7d000000-0000-4000-8000-0000000000c3', 'read')), true, 'A shares the tour with C (read)');
select is((select created from public.share_resource('7d000000-0000-4000-8000-0000000000a1', 'tour', '7d000000-0000-4000-8000-0000000071a1', '7d000000-0000-4000-8000-0000000000c3', 'read')), false, 'sharing again changes nothing');
select is((select created from public.share_resource('7d000000-0000-4000-8000-0000000000a1', 'tour', '7d000000-0000-4000-8000-0000000073a1', '7d000000-0000-4000-8000-0000000000b2', 'read')), true, 'A shares the tour to delete with B');
select is((select created from public.share_resource('7d000000-0000-4000-8000-0000000000f6', 'tour', '7d000000-0000-4000-8000-0000000071f6', '7d000000-0000-4000-8000-0000000000b2', 'read')), true, 'F shares a tour with B');
select throws_ok($$select * from public.share_resource('7d000000-0000-4000-8000-0000000000d4', 'tour', '7d000000-0000-4000-8000-0000000071a1', '7d000000-0000-4000-8000-0000000000b2', 'read')$$, 'P0001', 'not_found', 'D cannot share A''s tour');
select throws_ok($$select * from public.share_resource('7d000000-0000-4000-8000-0000000000a1', 'tour', '7d000000-0000-4000-8000-0000000071a1', '7d000000-0000-4000-8000-0000000000a1', 'read')$$, 'P0001', 'self_share', 'no self share');
select throws_ok($$select * from public.share_resource('7d000000-0000-4000-8000-0000000000e5', 'tour', '7d000000-0000-4000-8000-0000000071e5', '7d000000-0000-4000-8000-0000000000b2', 'read')$$, 'P0001', 'forbidden', 'the demo account cannot share');
select throws_ok($$select * from public.share_resource('7d000000-0000-4000-8000-0000000000a1', 'tours', '7d000000-0000-4000-8000-0000000071a1', '7d000000-0000-4000-8000-0000000000b2', 'read')$$, 'P0001', 'invalid', 'unknown resource kind');

-- ---------- B: write grantee ----------
reset role;
set local request.jwt.claims = '{"sub":"7d000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is(array(select id::text from public.city_tours where owner_id = '7d000000-0000-4000-8000-0000000000a1' order by id),
  array['7d000000-0000-4000-8000-0000000071a1', '7d000000-0000-4000-8000-0000000073a1'], 'B sees exactly the two tours shared with B, not the private one');
select is((select count(*)::int from public.city_tours where owner_id = '7d000000-0000-4000-8000-0000000000f6'), 1, 'B sees F''s shared tour while F is active');
select lives_ok($$update public.city_tours set title = 'Renamed by B' where id = '7d000000-0000-4000-8000-0000000071a1'$$, 'B may update the title');
select is((select title from public.city_tours where id = '7d000000-0000-4000-8000-0000000071a1'), 'Renamed by B', 'the title changed');
select throws_ok($$update public.city_tours set trip_id = '7d000000-0000-4000-8000-00000000a201', trip_day = 1 where id = '7d000000-0000-4000-8000-0000000071a1'$$, '42501', 'owner_only', 'B cannot link the tour to A''s trip');
update public.city_tours set title = 'Read-only rename' where id = '7d000000-0000-4000-8000-0000000073a1';
select is((select title from public.city_tours where id = '7d000000-0000-4000-8000-0000000073a1'), 'A tour to delete', 'B cannot update a tour shared read-only (visible, unchanged)');
delete from public.city_tours where id = '7d000000-0000-4000-8000-0000000071a1';
select is((select count(*)::int from public.city_tours where id = '7d000000-0000-4000-8000-0000000071a1'), 1, 'B cannot delete the tour');
select is((select count(*)::int from public.tour_shares), 3, 'B sees its own three share rows');

-- ---------- C: read grantee ----------
reset role;
set local request.jwt.claims = '{"sub":"7d000000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.city_tours), 1, 'C sees one tour');
update public.city_tours set title = 'By C' where id = '7d000000-0000-4000-8000-0000000071a1';
select is((select title from public.city_tours where id = '7d000000-0000-4000-8000-0000000071a1'), 'Renamed by B', 'C cannot update');
select is((select count(*)::int from public.tour_shares), 1, 'C sees only its own share row');

-- ---------- D: stranger ----------
reset role;
set local request.jwt.claims = '{"sub":"7d000000-0000-4000-8000-0000000000d4","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.city_tours), 0, 'D sees no tour');
select is((select count(*)::int from public.tour_shares), 0, 'D sees no share row');
select throws_ok($$insert into public.tour_shares (owner_id, tour_id, grantee_id, access) values ('7d000000-0000-4000-8000-0000000000a1', '7d000000-0000-4000-8000-0000000072a1', '7d000000-0000-4000-8000-0000000000d4', 'write')$$, '42501', null, 'D cannot insert a share row');

-- ---------- A: owner ----------
reset role;
set local request.jwt.claims = '{"sub":"7d000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select lives_ok($$update public.city_tours set trip_id = '7d000000-0000-4000-8000-00000000a201', trip_day = 1 where id = '7d000000-0000-4000-8000-0000000071a1'$$, 'the owner may link the tour to a trip');
select is((select trip_id::text || '/' || trip_day::text from public.city_tours where id = '7d000000-0000-4000-8000-0000000071a1'),
  '7d000000-0000-4000-8000-00000000a201/1', 'the owner''s trip link was saved');
select is((select count(*)::int from public.tour_shares), 3, 'A sees the three share rows of A''s tours');
select ok(exists (select 1 from public.share_contacts() where user_id = '7d000000-0000-4000-8000-0000000000b2'), 'B is in A''s share contacts');
select throws_ok($$insert into public.share_links (trip_id, tour_id, token_hash) values (null, '7d000000-0000-4000-8000-0000000071a1', repeat('a', 64))$$, '42501', null, 'A cannot insert a tour link directly (no column grant)');

-- ---------- share_links with a tour (as postgres, like the server with the secret key) ----------
reset role;
set local request.jwt.claims = '{}';
select lives_ok($$insert into public.share_links (owner_id, tour_id, token_hash) values ('7d000000-0000-4000-8000-0000000000a1', '7d000000-0000-4000-8000-0000000071a1', repeat('b', 64))$$, 'a link for a standalone tour');
select throws_ok($$insert into public.share_links (owner_id, token_hash) values ('7d000000-0000-4000-8000-0000000000a1', repeat('c', 64))$$, '23514', null, 'a link needs a target');
select throws_ok($$insert into public.share_links (owner_id, trip_id, tour_id, token_hash) values ('7d000000-0000-4000-8000-0000000000a1', '7d000000-0000-4000-8000-00000000a201', '7d000000-0000-4000-8000-0000000071a1', repeat('d', 64))$$, '23514', null, 'a link has only one target');
select throws_ok($$insert into public.share_links (owner_id, tour_id, token_hash) values ('7d000000-0000-4000-8000-0000000000d4', '7d000000-0000-4000-8000-0000000071a1', repeat('e', 64))$$, '23503', null, 'a tour link must belong to the tour owner');
select lives_ok($$insert into public.share_links (owner_id, trip_id, token_hash) values ('7d000000-0000-4000-8000-0000000000a1', '7d000000-0000-4000-8000-00000000a201', repeat('f', 64))$$, 'trip links still work');

-- ---------- disabled owner, leaving, deleting ----------
update public.profiles set disabled_at = now() where id = '7d000000-0000-4000-8000-0000000000f6';
set local request.jwt.claims = '{"sub":"7d000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.city_tours where owner_id = '7d000000-0000-4000-8000-0000000000f6'), 0, 'a disabled owner''s tour is hidden');
delete from public.tour_shares where tour_id = '7d000000-0000-4000-8000-0000000071a1';
select is((select count(*)::int from public.city_tours where id = '7d000000-0000-4000-8000-0000000071a1'), 0, 'B left the share and no longer sees the tour');

reset role;
set local request.jwt.claims = '{}';
delete from public.city_tours where id = '7d000000-0000-4000-8000-0000000073a1';
select is((select count(*)::int from public.tour_shares where tour_id = '7d000000-0000-4000-8000-0000000073a1'), 0, 'deleting a tour removes its shares');
delete from public.city_tours where id = '7d000000-0000-4000-8000-0000000071a1';
select is((select count(*)::int from public.share_links where token_hash = repeat('b', 64)), 0, 'deleting a tour removes its links');

select * from finish();
rollback;
