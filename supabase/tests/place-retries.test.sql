-- pgTAP tests for background place retries (migration 20261111120036). Run with `supabase test db`.
-- One transaction, rolled back. now() is constant inside it.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select * from no_plan();

-- ---------- grants and RLS: service role only ----------
select ok((select relrowsecurity from pg_class where oid = 'public.place_retry_jobs'::regclass), 'RLS enabled on place_retry_jobs');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'place_retry_jobs'), 0, 'no policies on place_retry_jobs');
select ok(not has_any_column_privilege('authenticated', 'public.place_retry_jobs', 'select'), 'authenticated: no select');
select ok(not has_any_column_privilege('anon', 'public.place_retry_jobs', 'select'), 'anon: no select');
select ok(not has_table_privilege('authenticated', 'public.place_retry_jobs', 'insert'), 'authenticated: no insert');
select ok(has_table_privilege('service_role', 'public.place_retry_jobs', 'insert'), 'service_role: insert');
select ok(has_function_privilege('service_role', 'public.place_retry_enqueue(jsonb)', 'execute'), 'service_role may enqueue');
select ok(not has_function_privilege('authenticated', 'public.place_retry_enqueue(jsonb)', 'execute'), 'authenticated may not enqueue');
select ok(not has_function_privilege('anon', 'public.place_retry_claim(integer, integer)', 'execute'), 'anon may not claim');
select ok(not has_function_privilege('authenticated', 'private.run_place_retries()', 'execute'), 'authenticated cannot run the cron body');

-- ---------- constraints ----------
select throws_ok($$insert into public.place_retry_jobs (kind, cache_key, params) values ('nope', 'k', '{}')$$, '23514', null, 'kind is checked');
select throws_ok($$insert into public.place_retry_jobs (kind, cache_key, params) values ('cafes', 'k', '[]')$$, '23514', null, 'params must be an object');
select throws_ok(
  $$insert into public.place_retry_jobs (kind, cache_key, params, created_at, give_up_at)
    values ('cafes', 'k', '{}', now(), now() + interval '31 minutes')$$,
  '23514', null, 'give_up_at is exactly created_at + 30 min');

-- ---------- enqueue: dedupe while queued, give_up_at not extended ----------
select is(public.place_retry_enqueue('[{"kind":"restaurants","cache_key":"r:1","params":{"kind":"restaurants"}},
                                       {"kind":"cafes","cache_key":"c:1","params":{"kind":"cafes"}}]'::jsonb), 2, 'two new jobs');
select is(public.place_retry_enqueue('[{"kind":"restaurants","cache_key":"r:1","params":{"kind":"restaurants"}}]'::jsonb), 0, 'same key while queued: ignored');
select is((select count(*)::int from public.place_retry_jobs where cache_key = 'r:1'), 1, 'one row per queued key');
select throws_ok($$select public.place_retry_enqueue('{"a":1}'::jsonb)$$, '22023', null, 'enqueue rejects a non-array');

-- Age one job, then re-enqueue: give_up_at stays.
update public.place_retry_jobs set created_at = now() - interval '10 minutes', give_up_at = now() + interval '20 minutes' where cache_key = 'r:1';
select public.place_retry_enqueue('[{"kind":"restaurants","cache_key":"r:1","params":{"kind":"restaurants"}}]'::jsonb);
select is((select give_up_at from public.place_retry_jobs where cache_key = 'r:1'), now() + interval '20 minutes', 're-enqueue does not extend give_up_at');

-- After a job is done, the same key may be queued again (a new search).
update public.place_retry_jobs set status = 'done' where cache_key = 'c:1';
select is(public.place_retry_enqueue('[{"kind":"cafes","cache_key":"c:1","params":{"kind":"cafes"}}]'::jsonb), 1, 'a done key can be queued again');

-- ---------- claim: oldest first, leased, past give_up_at excluded ----------
update public.place_retry_jobs set status = 'done' where cache_key = 'c:1'; -- keep the re-queued c:1 out of the claim test
select public.place_retry_enqueue('[{"kind":"interest","cache_key":"i:old","params":{"kind":"interest"}}]'::jsonb);
update public.place_retry_jobs set created_at = now() - interval '29 minutes', give_up_at = now() + interval '1 minute' where cache_key = 'i:old';
update public.place_retry_jobs set created_at = now() - interval '40 minutes', give_up_at = now() - interval '10 minutes' where cache_key = 'r:1';

select is((select array_agg(cache_key order by cache_key) from public.place_retry_claim(5, 360)), array['i:old'], 'claim skips jobs past give_up_at');
select is((select count(*)::int from public.place_retry_claim(5, 360)), 0, 'a leased job is not claimed again');

-- ---------- cron body: never raises without Vault secrets, logs once ----------
delete from public.app_events where event = 'places.retry_cron_unconfigured';
select lives_ok($$select private.run_place_retries()$$, 'cron body does not raise');
select is(private.run_place_retries(), false, 'no secret configured: does nothing');
select is((select count(*)::int from public.app_events where event = 'places.retry_cron_unconfigured'), 1, 'unconfigured is logged once per hour');
select ok(not exists (select 1 from public.app_events where event = 'places.retry_cron_unconfigured' and props::text ~* 'secret|bearer'), 'the log has no secret');

-- With nothing queued the body returns false without logging.
update public.place_retry_jobs set status = 'gave_up' where status = 'queued';
delete from public.app_events where event = 'places.retry_cron_unconfigured';
select is(private.run_place_retries(), false, 'nothing queued: does nothing');
select is((select count(*)::int from public.app_events where event = 'places.retry_cron_unconfigured'), 0, 'nothing queued: no log');

-- Finished rows older than 7 days are deleted (the updated_at trigger would reset the age, so it is off here).
alter table public.place_retry_jobs disable trigger place_retry_jobs_set_updated_at;
update public.place_retry_jobs set updated_at = now() - interval '8 days' where status = 'gave_up' and cache_key = 'i:old';
select private.run_place_retries();
select is((select count(*)::int from public.place_retry_jobs where cache_key = 'i:old'), 0, 'finished rows are purged after 7 days');

-- ---------- cron registration ----------
select ok(exists (select 1 from cron.job where jobname = 'place-retries' and schedule = '*/5 * * * *'), 'place-retries job is scheduled every 5 minutes');
select ok(not exists (select 1 from cron.job where jobname = 'place-retries' and command ~* 'secret|bearer'), 'the job command holds no secret');

select * from finish();
rollback;
