-- pgTAP tests for the log retention (migrations 20261122120047 and 20261123120048) and the admin database size. Run with `supabase test db`.
-- One transaction, rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select * from no_plan();

select ok(not has_function_privilege('authenticated', 'private.purge_logs()', 'execute'), 'authenticated cannot run the log purge');
select ok(not has_function_privilege('anon', 'private.purge_logs()', 'execute'), 'anon cannot run the log purge');
select is((select schedule from cron.job where jobname = 'purge-logs'), '45 2 * * *', 'the log purge runs nightly');
select is((select command from cron.job where jobname = 'purge-logs'), 'select private.purge_logs()', 'the nightly job calls the log purge');
select is((select count(*)::int from public.app_events where event = 'logs.purged' and created_at = now()), 0,
  'no purge event of this transaction yet');

-- Start from no expired rows, so the exact counts below only see this test's rows (rolled back at the end).
delete from public.api_cache where expires_at < now() - interval '180 days';
delete from public.api_calls where created_at < now() - interval '90 days';
delete from public.app_events where created_at < now() - interval '6 months' and event <> 'settings.changed';
delete from public.ai_usage where created_at < now() - interval '13 months';

-- api_cache: only rows whose expiry is more than 180 days past go
insert into public.api_cache (provider, cache_key, payload, expires_at) values
  ('retention_test', 'old', '{}', now() - interval '181 days'),
  ('retention_test', 'stale', '{}', now() - interval '179 days'),
  ('retention_test', 'fresh', '{}', now() + interval '1 day');

-- api_calls: only rows older than 90 days go
insert into public.api_calls (provider, endpoint, cache, ok, created_at) values
  ('retention_test', 'old', 'miss', true, now() - interval '91 days'),
  ('retention_test', 'recent', 'miss', true, now() - interval '89 days');

-- app_events: older than 6 months go, except the settings audit trail
insert into public.app_events (event, props, created_at) values
  ('retention_test.old', '{}', now() - interval '6 months' - interval '1 day'),
  ('retention_test.recent', '{}', now() - interval '6 months' + interval '1 day'),
  ('settings.changed', '{"key":"retention_test"}', now() - interval '2 years');

-- ai_usage: older than 13 months go
insert into public.ai_usage (task, model, status, error_code, created_at) values
  ('purpose_tags', 'retention-test', 'ok', 'old', now() - interval '13 months' - interval '1 day'),
  ('purpose_tags', 'retention-test', 'ok', 'recent', now() - interval '13 months' + interval '1 day');

select is(private.purge_logs(), '{"apiCache": 1, "apiCalls": 1, "appEvents": 1, "aiUsage": 1}'::jsonb,
  'one old row of each log is purged');
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
select results_eq(
  $$select event from public.app_events where event like 'retention_test.%' or props->>'key' = 'retention_test' order by event$$,
  $$values ('retention_test.recent'), ('settings.changed')$$,
  'events within 6 months and the settings audit trail are kept'
);
select results_eq(
  $$select error_code from public.ai_usage where model = 'retention-test'$$,
  $$values ('recent')$$,
  'AI usage within 13 months is kept'
);
-- now() is the transaction start, so created_at = now() picks only events written in this test.
select results_eq(
  $$select props from public.app_events where event = 'logs.purged' and created_at = now()$$,
  $$values ('{"apiCache": 1, "apiCalls": 1, "appEvents": 1, "aiUsage": 1}'::jsonb)$$,
  'this purge is logged once, with its counts'
);

select is(private.purge_logs(), '{"apiCache": 0, "apiCalls": 0, "appEvents": 0, "aiUsage": 0}'::jsonb, 'a second run purges nothing');
select is((select count(*)::int from public.app_events where event = 'logs.purged' and created_at = now()), 1,
  'a run that purges nothing logs no event');


-- ---------- admin database size ----------
select ok(not has_function_privilege('authenticated', 'public.admin_db_stats()', 'execute'), 'authenticated cannot read the database size');
select ok(not has_function_privilege('anon', 'public.admin_db_stats()', 'execute'), 'anon cannot read the database size');
select ok(has_function_privilege('service_role', 'public.admin_db_stats()', 'execute'), 'service_role reads the database size');
select ok((public.admin_db_stats()->>'totalBytes')::bigint > 0, 'the total size is positive');
select results_eq(
  $$select t->>'name' from jsonb_array_elements(public.admin_db_stats()->'tables') with ordinality as x(t, i) order by i$$,
  -- relname is of type name (collation "C"); the jsonb text has the default collation, so state it to compare.
  $$select x.name collate "default" from (
      select c.relname::text as name, pg_catalog.pg_total_relation_size(c.oid) as bytes
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by bytes desc, name limit 5) x
    order by x.bytes desc, x.name$$,
  'the five largest public tables are listed, largest first'
);
select ok((select bool_and(t ? 'name' and t ? 'bytes' and (t->>'bytes')::bigint >= 0)
  from jsonb_array_elements(public.admin_db_stats()->'tables') t), 'each table has a name and a size');

-- ---------- unused RPC dropped ----------
select hasnt_function('public', 'reorder_group_entries', array['uuid', 'uuid[]'], 'reorder_group_entries is dropped');

select * from finish();
rollback;
