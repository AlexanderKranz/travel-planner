-- Retention for the server-only cache and call log, as planned in 20261029120011 (api_cache: rows whose expiry is
-- more than 180 days past; they are only kept to serve "stale" when a refresh fails) and 20261029120012 (api_calls:
-- 90 days; the admin page and every quota read at most the current month). Own function and cron job, so the trip
-- purge does not grow further. The retention of app_events and ai_usage is not decided yet and stays untouched.

create or replace function private.purge_logs()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  deleted_cache integer;
  deleted_calls integer;
begin
  delete from public.api_cache where expires_at < now() - interval '180 days';
  get diagnostics deleted_cache = row_count;

  delete from public.api_calls where created_at < now() - interval '90 days';
  get diagnostics deleted_calls = row_count;

  if deleted_cache > 0 or deleted_calls > 0 then
    insert into public.app_events (event, props)
      values ('logs.purged', jsonb_build_object('apiCache', deleted_cache, 'apiCalls', deleted_calls));
  end if;
  return jsonb_build_object('apiCache', deleted_cache, 'apiCalls', deleted_calls);
end;
$$;

revoke all on function private.purge_logs() from public, anon, authenticated;

-- 02:45 UTC daily, after the 01:00 UTC backup and the 02:30 trip purge. cron.schedule upserts by job name.
select cron.schedule('purge-logs', '45 2 * * *', 'select private.purge_logs()');
