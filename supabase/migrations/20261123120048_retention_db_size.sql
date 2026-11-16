-- Retention for app_events (6 months) and ai_usage (13 months), the database size for the admin page, and the
-- unused reorder_group_entries RPC dropped.
--
-- Nothing reads further back: the admin page and every limit read at most the current month or 30 days of events and
-- the current month of AI cost. 13 months keeps a year-over-year cost comparison possible. `settings.changed` events
-- are the audit trail of admin setting changes (the settings section shows the last 20): a handful of rows, kept.

create or replace function private.purge_logs()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  deleted_cache integer;
  deleted_calls integer;
  deleted_events integer;
  deleted_ai integer;
begin
  delete from public.api_cache where expires_at < now() - interval '180 days';
  get diagnostics deleted_cache = row_count;

  delete from public.api_calls where created_at < now() - interval '90 days';
  get diagnostics deleted_calls = row_count;

  delete from public.app_events where created_at < now() - interval '6 months' and event <> 'settings.changed';
  get diagnostics deleted_events = row_count;

  delete from public.ai_usage where created_at < now() - interval '13 months';
  get diagnostics deleted_ai = row_count;

  if deleted_cache > 0 or deleted_calls > 0 or deleted_events > 0 or deleted_ai > 0 then
    insert into public.app_events (event, props)
      values ('logs.purged', jsonb_build_object(
        'apiCache', deleted_cache, 'apiCalls', deleted_calls, 'appEvents', deleted_events, 'aiUsage', deleted_ai));
  end if;
  return jsonb_build_object(
    'apiCache', deleted_cache, 'apiCalls', deleted_calls, 'appEvents', deleted_events, 'aiUsage', deleted_ai);
end;
$$;

revoke all on function private.purge_logs() from public, anon, authenticated;

-- ---------- database size for the admin page ----------
-- Total size and the five largest public tables (name and bytes: schema metadata, no content). Executable by
-- service_role only, like the other admin_* functions (called after requireAdmin()).
create or replace function public.admin_db_stats()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'totalBytes', pg_catalog.pg_database_size(pg_catalog.current_database()),
    'tables', coalesce((
      select jsonb_agg(jsonb_build_object('name', t.name, 'bytes', t.bytes) order by t.bytes desc, t.name)
      from (
        select c.relname::text as name, pg_catalog.pg_total_relation_size(c.oid) as bytes
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
        order by bytes desc, name
        limit 5
      ) t
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.admin_db_stats() from public, anon, authenticated;
grant execute on function public.admin_db_stats() to service_role;

-- ---------- unused RPC ----------
-- Its server action (reorderGroupEntries) had no UI and was removed in #245; entries keep their order through
-- replace_group_entries.
drop function if exists public.reorder_group_entries(uuid, uuid[]);
