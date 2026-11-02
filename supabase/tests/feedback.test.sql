-- pgTAP tests for feedback (migration 20261108120033). Run with `supabase test db`.
-- One transaction, rolled back. now() is constant inside it, so "Berlin day" boundaries cannot flake.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select * from no_plan();

insert into public.signup_allowlist (email) values ('fa@test.dev'), ('fb@test.dev');
insert into auth.users (id, email, raw_user_meta_data, aud, role) values
  ('fa000000-0000-4000-8000-000000000001', 'fa@test.dev', '{}', 'authenticated', 'authenticated'),
  ('fb000000-0000-4000-8000-000000000002', 'fb@test.dev', '{}', 'authenticated', 'authenticated');

-- ---------- grants ----------
select ok(has_table_privilege('authenticated', 'public.feedback', 'select'), 'authenticated: select on feedback');
select ok(not has_table_privilege('authenticated', 'public.feedback', 'insert'), 'authenticated: no insert on feedback');
select ok(not has_table_privilege('authenticated', 'public.feedback', 'update'), 'authenticated: no update on feedback');
select ok(not has_table_privilege('authenticated', 'public.feedback', 'delete'), 'authenticated: no delete on feedback');
select ok(not has_any_column_privilege('authenticated', 'public.feedback', 'insert'), 'authenticated: no column insert on feedback');
select ok(not has_any_column_privilege('authenticated', 'public.feedback', 'update'), 'authenticated: no column update on feedback');
select ok(not has_table_privilege('anon', 'public.feedback', 'select'), 'anon: no select on feedback');
select ok(has_table_privilege('service_role', 'public.feedback', 'insert'), 'service_role: insert on feedback');
select ok((select relrowsecurity from pg_class where oid = 'public.feedback'::regclass), 'RLS enabled on feedback');

-- ---------- function privileges: service_role only ----------
select ok(has_function_privilege('service_role', 'public.feedback_submit(uuid, text, text, text, text, text, text, text, integer)', 'execute'), 'service_role may execute feedback_submit');
select ok(not has_function_privilege('authenticated', 'public.feedback_submit(uuid, text, text, text, text, text, text, text, integer)', 'execute'), 'authenticated may not execute feedback_submit');
select ok(not has_function_privilege('anon', 'public.feedback_submit(uuid, text, text, text, text, text, text, text, integer)', 'execute'), 'anon may not execute feedback_submit');
select ok(has_function_privilege('service_role', 'public.feedback_claim(uuid, integer)', 'execute'), 'service_role may execute feedback_claim');
select ok(not has_function_privilege('authenticated', 'public.feedback_claim(uuid, integer)', 'execute'), 'authenticated may not execute feedback_claim');
select ok(not has_function_privilege('anon', 'public.feedback_claim(uuid, integer)', 'execute'), 'anon may not execute feedback_claim');
select ok((select prosecdef from pg_proc where oid = 'public.feedback_claim(uuid, integer)'::regprocedure), 'feedback_claim is security definer');
select ok((select prosecdef from pg_proc where oid = 'public.feedback_submit(uuid, text, text, text, text, text, text, text, integer)'::regprocedure), 'feedback_submit is security definer');

-- ---------- constraints (as postgres) ----------
select throws_ok($$insert into public.feedback (ref, owner_id, kind, body, app_version, locale) values ('FB-bad', 'fa000000-0000-4000-8000-000000000001', 'bug', 'text', 'local', 'en')$$,
  '23514', null, 'ref format is checked');
select throws_ok($$insert into public.feedback (ref, owner_id, kind, body, app_version, locale) values ('FB-k3x9p2qo', 'fa000000-0000-4000-8000-000000000001', 'bug', 'text', 'local', 'en')$$,
  '23514', null, 'ref alphabet excludes o');
select throws_ok($$insert into public.feedback (ref, owner_id, kind, body, app_version, locale) values ('FB-k3x9p2qa', 'fa000000-0000-4000-8000-000000000001', 'rant', 'text', 'local', 'en')$$,
  '23514', null, 'kind is checked');
select throws_ok($$insert into public.feedback (ref, owner_id, kind, body, app_version, locale) values ('FB-k3x9p2qa', 'fa000000-0000-4000-8000-000000000001', 'bug', '', 'local', 'en')$$,
  '23514', null, 'empty body is rejected');
select throws_ok($$insert into public.feedback (ref, owner_id, kind, body, app_version, locale) values ('FB-k3x9p2qa', 'fa000000-0000-4000-8000-000000000001', 'bug', 'text', 'NOTHEX1', 'en')$$,
  '23514', null, 'app_version is checked');
select throws_ok($$insert into public.feedback (ref, owner_id, kind, body, app_version, locale) values ('FB-k3x9p2qa', 'fa000000-0000-4000-8000-000000000001', 'bug', 'text', 'local', 'fr')$$,
  '23514', null, 'locale is checked');
select lives_ok($$insert into public.feedback (ref, owner_id, kind, body, app_version, locale) values ('FB-k3x9p2qa', 'fa000000-0000-4000-8000-000000000001', 'bug', 'text', 'a1b2c3d', 'en')$$,
  'valid row inserts');
select throws_ok($$insert into public.feedback (ref, owner_id, kind, body, app_version, locale) values ('FB-k3x9p2qa', 'fa000000-0000-4000-8000-000000000001', 'bug', 'text', 'local', 'en')$$,
  '23505', null, 'ref is unique');
select throws_ok($$update public.feedback set status = 'created' where ref = 'FB-k3x9p2qa'$$,
  '23514', null, 'created requires issue_number, issue_url and issue_created_at');
select throws_ok($$update public.feedback set status = 'created', issue_number = 1, issue_created_at = now(), issue_url = 'https://evil.example/x/y/issues/1' where ref = 'FB-k3x9p2qa'$$,
  '23514', null, 'issue_url must be a github issue url');
select lives_ok($$update public.feedback set status = 'created', issue_number = 1, issue_created_at = now(), issue_url = 'https://github.com/o/r/issues/1', body = null where ref = 'FB-k3x9p2qa'$$,
  'created row with a proper issue url is accepted (body may be null)');
delete from public.feedback;

-- ---------- RLS: owners see only their own rows; users cannot write ----------
insert into public.feedback (ref, owner_id, kind, body, app_version, locale) values
  ('FB-aaaaaaa2', 'fa000000-0000-4000-8000-000000000001', 'bug',  'from A', 'local', 'en'),
  ('FB-bbbbbbb2', 'fb000000-0000-4000-8000-000000000002', 'idea', 'from B', 'local', 'de');

set local request.jwt.claims = '{"sub":"fa000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.feedback), 1, 'A sees exactly one feedback row');
select is((select ref from public.feedback), 'FB-aaaaaaa2', 'A sees only own row');
select throws_ok($$insert into public.feedback (ref, owner_id, kind, body, app_version, locale) values ('FB-ccccccc2', 'fa000000-0000-4000-8000-000000000001', 'bug', 'x', 'local', 'en')$$,
  '42501', null, 'A cannot insert feedback directly (also the demo user)');
select throws_ok($$update public.feedback set body = 'x'$$, '42501', null, 'A cannot update feedback');
select throws_ok($$delete from public.feedback$$, '42501', null, 'A cannot delete feedback');
select throws_ok($$select public.feedback_submit('fa000000-0000-4000-8000-000000000001', 'FB-ddddddd2', 'bug', 'x', null, 'local', null, 'en', 10)$$,
  '42501', null, 'A cannot call feedback_submit');
select throws_ok($$select * from public.feedback_claim('00000000-0000-4000-8000-000000000000', 10)$$,
  '42501', null, 'A cannot call feedback_claim');

set local request.jwt.claims = '{"sub":"fb000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select ref from public.feedback), 'FB-bbbbbbb2', 'B sees only own row');
reset role;
set local request.jwt.claims = '{"role":"anon"}';
set local role anon;
select throws_ok($$select count(*) from public.feedback$$, '42501', null, 'anon cannot read feedback');
reset role;
delete from public.feedback;

-- ---------- feedback_submit: 10 per Berlin day ----------
set local role service_role;
select is((select count(*)::int from (
  select (public.feedback_submit('fa000000-0000-4000-8000-000000000001', 'FB-subaaaa' || chr(96 + g), 'bug', 'text ' || g, '/app/x', 'local', null, 'en', 10)).outcome
    from generate_series(1, 10) g) s where outcome = 'created'), 10, 'first 10 reports are created');
select is((select outcome from public.feedback_submit('fa000000-0000-4000-8000-000000000001', 'FB-sub22222', 'bug', 'eleventh', null, 'local', null, 'en', 10)),
  'limited', 'the 11th report of the Berlin day returns limited');
select is((select count(*)::int from public.feedback where owner_id = 'fa000000-0000-4000-8000-000000000001'), 10, 'the limited call inserted nothing');
select is((select outcome from public.feedback_submit('fb000000-0000-4000-8000-000000000002', 'FB-subbbbb2', 'idea', 'other user', null, 'local', null, 'de', 10)),
  'created', 'the limit is per user');
select is((select outcome from public.feedback_submit('fb000000-0000-4000-8000-000000000002', 'FB-subbbbb3', 'idea', 'limit 0', null, 'local', null, 'de', 0)),
  'limited', 'a limit of 0 always returns limited');
select throws_ok($$select * from public.feedback_submit('fb000000-0000-4000-8000-000000000002', 'FB-subbbbb2', 'idea', 'dup ref', null, 'local', null, 'de', 10)$$,
  '23505', null, 'a duplicate ref raises unique_violation');
reset role;
-- yesterday's reports do not count: move A's rows before Berlin midnight
update public.feedback set created_at = now() - interval '2 days' where owner_id = 'fa000000-0000-4000-8000-000000000001';
set local role service_role;
select is((select outcome from public.feedback_submit('fa000000-0000-4000-8000-000000000001', 'FB-newday22', 'bug', 'new day', null, 'local', null, 'en', 10)),
  'created', 'reports from earlier days do not count');
reset role;

-- ---------- feedback_claim: app-wide ceiling ----------
delete from public.feedback;
insert into public.feedback (id, ref, owner_id, kind, body, app_version, locale, status, issue_number, issue_url, issue_created_at) values
  ('11111111-0000-4000-8000-000000000001', 'FB-claim222', 'fa000000-0000-4000-8000-000000000001', 'bug', null, 'local', 'en', 'created', 1, 'https://github.com/o/r/issues/1', now()),
  ('11111111-0000-4000-8000-000000000002', 'FB-claim223', 'fa000000-0000-4000-8000-000000000001', 'bug', null, 'local', 'en', 'created', 2, 'https://github.com/o/r/issues/2', now() - interval '2 days');
insert into public.feedback (id, ref, owner_id, kind, body, app_version, locale) values
  ('22222222-0000-4000-8000-000000000001', 'FB-claim224', 'fa000000-0000-4000-8000-000000000001', 'bug', 'p1', 'local', 'en'),
  ('22222222-0000-4000-8000-000000000002', 'FB-claim225', 'fa000000-0000-4000-8000-000000000001', 'bug', 'p2', 'local', 'en'),
  ('22222222-0000-4000-8000-000000000003', 'FB-claim226', 'fb000000-0000-4000-8000-000000000002', 'idea', 'p3', 'local', 'de');

set local role service_role;
-- used today = 1 created (the one from 2 days ago does not count)
select is((select count(*)::int from public.feedback_claim('22222222-0000-4000-8000-000000000001', 0)), 0, 'ceiling 0 pauses claims');
select is((select count(*)::int from public.feedback_claim('22222222-0000-4000-8000-000000000001', 1)), 0, 'no lease at the ceiling (1 created today, ceiling 1)');
select is((select attempts::int from public.feedback where id = '22222222-0000-4000-8000-000000000001'), 0, 'a refused claim leaves attempts alone');
select is((select count(*)::int from public.feedback_claim('22222222-0000-4000-8000-000000000001', 3)), 1, 'claim succeeds below the ceiling');
select is((select attempts::int from public.feedback where id = '22222222-0000-4000-8000-000000000001'), 1, 'a claim increments attempts');
select ok((select lease_until > now() and next_attempt_at > now() from public.feedback where id = '22222222-0000-4000-8000-000000000001'), 'a claim sets the 10 minute lease and next_attempt_at');
select is((select count(*)::int from public.feedback_claim('22222222-0000-4000-8000-000000000001', 3)), 0, 'a leased row cannot be claimed twice');
-- used = 1 created + 1 leased = 2
select is((select count(*)::int from public.feedback_claim('22222222-0000-4000-8000-000000000002', 2)), 0, 'a leased row counts against the ceiling');
select is((select count(*)::int from public.feedback_claim('22222222-0000-4000-8000-000000000002', 3)), 1, 'the next row is leased with one slot left');
-- used = 3
select is((select count(*)::int from public.feedback_claim('22222222-0000-4000-8000-000000000003', 3)), 0, 'ceiling reached with leases counted');
reset role;
-- a back-off (next_attempt_at in the future, no live lease) does not count and is not claimable until due
update public.feedback set lease_until = now() - interval '1 minute', next_attempt_at = now() + interval '1 hour'
 where id = '22222222-0000-4000-8000-000000000001';
update public.feedback set lease_until = now() - interval '1 minute', next_attempt_at = now() - interval '1 minute'
 where id = '22222222-0000-4000-8000-000000000002';
set local role service_role;
select is((select count(*)::int from public.feedback_claim('22222222-0000-4000-8000-000000000001', 3)), 0, 'a row in back-off is not claimable');
select is((select count(*)::int from public.feedback_claim('22222222-0000-4000-8000-000000000003', 3)), 1, 'expired leases free their slots');
select is((select count(*)::int from public.feedback_claim('22222222-0000-4000-8000-000000000002', 4)), 1, 'an expired lease on a due row can be claimed again');
select is((select attempts::int from public.feedback where id = '22222222-0000-4000-8000-000000000002'), 2, 'the retry increments attempts');
reset role;
update public.feedback set status = 'failed' where id = '22222222-0000-4000-8000-000000000003';
set local role service_role;
select is((select count(*)::int from public.feedback_claim('22222222-0000-4000-8000-000000000003', 50)), 0, 'a failed row is not claimable');
reset role;

-- ---------- storage bucket (only where the storage schema exists) ----------
-- plpgsql plans lazily, so this compiles even when storage.buckets does not exist (stack without storage-api).
create function pg_temp.bucket_check(p_what int) returns boolean language plpgsql as $f$
begin
  if p_what = 1 then
    return exists (select 1 from storage.buckets where id = 'feedback-screenshots' and not public);
  elsif p_what = 2 then
    return exists (select 1 from storage.buckets where id = 'feedback-screenshots' and file_size_limit = 2097152
      and allowed_mime_types @> array['image/png', 'image/jpeg', 'image/webp'] and cardinality(allowed_mime_types) = 3);
  end if;
  return not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and (qual like '%feedback-screenshots%' or with_check like '%feedback-screenshots%'));
end $f$;
select case when to_regclass('storage.buckets') is null
  then skip('storage schema not present (stack started without storage-api)', 3)
  else collect_tap(
    ok(pg_temp.bucket_check(1), 'bucket feedback-screenshots exists and is private'),
    ok(pg_temp.bucket_check(2), 'bucket limits: 2 MB, png/jpeg/webp'),
    ok(pg_temp.bucket_check(3), 'no storage policy mentions the bucket')
  ) end;

select * from finish();
rollback;
