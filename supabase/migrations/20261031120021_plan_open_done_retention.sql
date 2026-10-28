-- Open-item checkboxes (keys from openItemKey) + item activity keeps a trip alive. Spec phase 5, 1.3.

alter table public.plans
  add column if not exists open_done text[] not null default '{}';
alter table public.plans drop constraint if exists plans_open_done_max;
alter table public.plans add constraint plans_open_done_max check (cardinality(open_done) <= 50);

grant update (busy_until, open_done) on public.plans to authenticated;

-- Last update = latest of trip, plan and any item (greatest ignores nulls). Signature, grants and cron unchanged.
create or replace function private.purge_expired_trips()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.trips t
  using (select t2.id,
                greatest(t2.updated_at, p.updated_at,
                         (select max(i.updated_at) from public.trip_items i where i.trip_id = t2.id)) as last_update
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
