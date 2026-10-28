-- Trip items (hotels, courses, car, flights booked ...) with status and price. Spec docs/specs/phase-5-share-export.md 1.1.
-- Own table (not plan JSON): status toggles create no plan versions and never touch trips.updated_at.

create table if not exists public.trip_items (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  trip_id     uuid not null,
  category    text not null check (category in ('flight', 'stay', 'car', 'transport', 'activity', 'food', 'other')),
  title       text not null check (char_length(title) between 1 and 120),
  status      text not null default 'option' check (status in ('option', 'planned', 'booked', 'rejected')),
  price_cents bigint check (price_cents between 0 and 100000000),
  price_basis text not null default 'total' check (price_basis in ('total', 'per_person')),
  persons     smallint check (persons between 1 and 50),
  currency    text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  day         smallint check (day between 1 and 60),
  ref         text check (ref ~ '^(node|way|relation)/\d{1,15}$'),
  url         text check (char_length(url) <= 500 and url ~ '^https?://'),
  notes       text check (char_length(notes) <= 1000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (trip_id, owner_id) references public.trips (id, owner_id) on delete cascade
);

create index if not exists trip_items_trip_idx on public.trip_items (trip_id, day nulls last, created_at);

alter table public.trip_items enable row level security;
revoke all on table public.trip_items from anon, authenticated, public;
grant select, delete on public.trip_items to authenticated;
-- owner_id comes from its default (auth.uid()); trip_id is fixed after insert.
grant insert (trip_id, category, title, status, price_cents, price_basis, persons, currency, day, ref, url, notes)
  on public.trip_items to authenticated;
grant update (category, title, status, price_cents, price_basis, persons, currency, day, ref, url, notes)
  on public.trip_items to authenticated;

drop policy if exists "trip_items: owner select" on public.trip_items;
create policy "trip_items: owner select" on public.trip_items
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists "trip_items: owner insert" on public.trip_items;
create policy "trip_items: owner insert" on public.trip_items
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists "trip_items: owner update" on public.trip_items;
create policy "trip_items: owner update" on public.trip_items
  for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "trip_items: owner delete" on public.trip_items;
create policy "trip_items: owner delete" on public.trip_items
  for delete to authenticated using ((select auth.uid()) = owner_id);

drop trigger if exists trip_items_set_updated_at on public.trip_items;
create trigger trip_items_set_updated_at
  before update on public.trip_items
  for each row execute function private.set_updated_at();
