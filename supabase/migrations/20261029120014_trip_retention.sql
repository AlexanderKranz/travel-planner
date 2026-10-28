-- Trip retention: a trip is deleted 18 months after its last relevant date, i.e. the later of
-- its last update and (for exact dates) its end date. Month-only and undated trips expire 18 months
-- after their last update. Runs nightly via pg_cron inside the database.

create extension if not exists pg_cron with schema pg_catalog;

create or replace function private.trip_expires_on(updated_at timestamptz, start_date date, length_days smallint)
returns date
language sql
stable
set search_path = ''
as $$
  select (greatest((updated_at at time zone 'Europe/Berlin')::date,
                   coalesce(start_date + length_days - 1, '-infinity'::date)) + interval '18 months')::date
$$;

create or replace function private.purge_expired_trips()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.trips t
  where private.trip_expires_on(t.updated_at, t.start_date, t.length_days)
        < (now() at time zone 'Europe/Berlin')::date;
  get diagnostics deleted = row_count;
  if deleted > 0 then
    insert into public.app_events (event, props) values ('trips.purged', jsonb_build_object('count', deleted));
  end if;
  return deleted;
end;
$$;

revoke all on function private.trip_expires_on(timestamptz, date, smallint) from public, anon, authenticated;
revoke all on function private.purge_expired_trips() from public, anon, authenticated;

-- 02:30 UTC daily, after the 01:00 UTC backup. cron.schedule upserts by job name.
select cron.schedule('purge-expired-trips', '30 2 * * *', 'select private.purge_expired_trips()');
