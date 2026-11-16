-- pgTAP tests for the cache and call-log retention (migration 20261122120047). Run with `supabase test db`.
-- One transaction, rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select * from no_plan();

select ok(not has_function_privilege('authenticated', 'private.purge_logs()', 'execute'), 'authenticated cannot run the log purge');
select ok(not has_function_privilege('anon', 'private.purge_logs()', 'execute'), 'anon cannot run the log purge');
select is((select schedule from cron.job where jobname = 'purge-logs'), '45 2 * * *', 'the log purge runs nightly');

-- api_cache: only rows whose expiry is more than 180 days past go
insert into public.api_cache (provider, cache_key, payload, expires_at) values
  ('retention_test', 'old', '{}', now() - interval '181 days'),
  ('retention_test', 'stale', '{}', now() - interval '179 days'),
  ('retention_test', 'fresh', '{}', now() + interval '1 day');

-- api_calls: only rows older than 90 days go
insert into public.api_calls (provider, endpoint, cache, ok, created_at) values
  ('retention_test', 'old', 'miss', true, now() - interval '91 days'),
  ('retention_test', 'recent', 'miss', true, now() - interval '89 days');

select is(private.purge_logs(), '{"apiCache": 1, "apiCalls": 1}'::jsonb, 'one old cache row and one old call are purged');
select results_eq(
  $$select cache_key from public.api_cache where provider = 'retention_test' order by cache_key$$,
  $$values ('fresh'), ('stale')$$,
  'cache rows within 180 days past expiry are kept'
);
select results_eq(
  $$select endpoint from public.api_calls where provider = 'retention_test'$$,
  $$values ('recent')$$,
  'calls within 90 days are kept'
);
select is((select props from public.app_events where event = 'logs.purged' order by created_at desc limit 1),
  '{"apiCache": 1, "apiCalls": 1}'::jsonb, 'the purge is logged with counts');

select is(private.purge_logs(), '{"apiCache": 0, "apiCalls": 0}'::jsonb, 'a second run purges nothing');

select * from finish();
rollback;
