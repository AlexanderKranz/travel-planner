-- Find destinations by trip purpose (docs/specs/find-destinations.md section 8, ADR 0006).
-- destination_searches: one saved list of verified suggestions per search, owner-only. Not api_cache: a list derives
-- from the user's purpose, group and airports (ground rule 6). trips.destination_search_id links a trip back to it.

-- ---------- destination_searches ----------
create table if not exists public.destination_searches (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  purpose_id       uuid,
  group_id         uuid,
  purpose_name     text not null check (char_length(purpose_name) between 1 and 80),
  locale           text not null check (locale in ('de', 'en')),
  months           smallint[] not null default '{}'
    check (cardinality(months) <= 3 and months <@ array[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[]),
  origins          text[] not null default '{}'
    check (cardinality(origins) <= 2 and array_to_string(origins, ',') ~ '^([A-Z]{3}(,[A-Z]{3})*)?$'),
  max_flight_hours numeric(3, 1) check (max_flight_hours between 1 and 15),
  radius_km        integer check (radius_km between 1 and 20000),
  input_hash       text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  input            jsonb not null check (jsonb_typeof(input) = 'object' and pg_column_size(input) < 8192),
  status           text not null default 'running' check (status in ('running', 'done', 'failed')),
  busy_until       timestamptz,
  rounds           smallint not null default 1 check (rounds in (1, 2)),
  cards            jsonb not null default '[]' check (jsonb_typeof(cards) = 'array' and pg_column_size(cards) < 65536),
  drops            jsonb not null default '{}' check (jsonb_typeof(drops) = 'object' and pg_column_size(drops) < 2048),
  -- Why a failed list failed (an ActionError code), so a page opened after the browser left can say it.
  error_code       text check (char_length(error_code) <= 40),
  model            text check (char_length(model) <= 60),
  cost_micro_usd   integer not null default 0 check (cost_micro_usd >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- same-owner references; deleting a purpose/group keeps the list (it has its purpose_name snapshot)
  foreign key (purpose_id, owner_id) references public.trip_purposes (id, owner_id) on delete set null (purpose_id),
  foreign key (group_id, owner_id)   references public.travel_groups (id, owner_id) on delete set null (group_id),
  -- target of the composite FK trips (destination_search_id, owner_id)
  constraint destination_searches_id_owner_key unique (id, owner_id),
  -- one list per owner and input; a failed or old list is reused in place
  constraint destination_searches_owner_hash_key unique (owner_id, input_hash)
);

-- updated_at, not created_at: a failed or old list is reused in place, and then counts as new.
create index if not exists destination_searches_owner_idx on public.destination_searches (owner_id, updated_at desc);
-- One search at a time per user. A row past busy_until is set to failed by the server before a new one starts.
create unique index if not exists destination_searches_running_idx
  on public.destination_searches (owner_id) where status = 'running';

alter table public.destination_searches enable row level security;
revoke all on table public.destination_searches from anon, authenticated, public;
grant select, delete on public.destination_searches to authenticated;
-- id, owner_id (default auth.uid()) and created_at can never be written by a user session.
grant insert (purpose_id, group_id, purpose_name, locale, months, origins, max_flight_hours, radius_km, input_hash,
              input, status, busy_until, rounds, cards, drops, error_code, model, cost_micro_usd)
  on public.destination_searches to authenticated;
grant update (purpose_id, group_id, purpose_name, locale, months, origins, max_flight_hours, radius_km,
              input, status, busy_until, rounds, cards, drops, error_code, model, cost_micro_usd)
  on public.destination_searches to authenticated;

drop policy if exists "destination_searches: owner select" on public.destination_searches;
create policy "destination_searches: owner select" on public.destination_searches
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists "destination_searches: owner insert" on public.destination_searches;
create policy "destination_searches: owner insert" on public.destination_searches
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists "destination_searches: owner update" on public.destination_searches;
create policy "destination_searches: owner update" on public.destination_searches
  for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "destination_searches: owner delete" on public.destination_searches;
create policy "destination_searches: owner delete" on public.destination_searches
  for delete to authenticated using ((select auth.uid()) = owner_id);

drop trigger if exists destination_searches_set_updated_at on public.destination_searches;
create trigger destination_searches_set_updated_at
  before update on public.destination_searches
  for each row execute function private.set_updated_at();

-- ---------- trips.destination_search_id ----------
alter table public.trips add column if not exists destination_search_id uuid;
-- Same-owner link: a trip cannot point at another user's list. Deleting the list clears only the reference.
alter table public.trips drop constraint if exists trips_destination_search_fkey;
alter table public.trips add constraint trips_destination_search_fkey
  foreign key (destination_search_id, owner_id)
  references public.destination_searches (id, owner_id) on delete set null (destination_search_id);
create index if not exists trips_destination_search_idx on public.trips (destination_search_id) where destination_search_id is not null;
grant insert (destination_search_id) on public.trips to authenticated;
grant update (destination_search_id) on public.trips to authenticated;

-- ---------- ai_usage: new task for the Haiku ideas call ----------
alter table public.ai_usage drop constraint if exists ai_usage_task_check;
alter table public.ai_usage add constraint ai_usage_task_check
  check (task in ('purpose_tags', 'group_parse', 'destination_ideas', 'plan_generate', 'plan_patch'));

-- ---------- retention ----------
-- Same as 20261031120021 (trips), plus lists older than 90 days. Signature, grants and cron schedule unchanged.
-- The newest 10 per user are kept by the server after each insert.
create or replace function private.purge_expired_trips()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  deleted integer;
  deleted_searches integer;
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

  delete from public.destination_searches where updated_at < now() - interval '90 days';
  get diagnostics deleted_searches = row_count;
  if deleted_searches > 0 then
    insert into public.app_events (event, props)
      values ('destination_searches.purged', jsonb_build_object('count', deleted_searches));
  end if;
  return deleted;
end;
$$;

revoke all on function private.purge_expired_trips() from public, anon, authenticated;
