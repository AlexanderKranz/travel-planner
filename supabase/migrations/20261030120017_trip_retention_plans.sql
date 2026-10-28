-- Plan activity keeps a trip alive: the "last update" is the later of trips.updated_at and plans.updated_at
-- (the version trigger bumps plans.updated_at on every new version). Signature, grants and the cron job are unchanged.

create or replace function private.purge_expired_trips()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.trips t
  using (select t2.id, greatest(t2.updated_at, coalesce(p.updated_at, t2.updated_at)) as last_update
           from public.trips t2
           left join public.plans p on p.trip_id = t2.id) x
  where x.id = t.id
    and private.trip_expires_on(x.last_update, t.start_date, t.length_days)
        < (now() at time zone 'Europe/Berlin')::date;
  get diagnostics deleted = row_count;
  if deleted > 0 then
    insert into public.app_events (event, props) values ('trips.purged', jsonb_build_object('count', deleted));
  end if;
  return deleted;
end;
$$;

revoke all on function private.purge_expired_trips() from public, anon, authenticated;
