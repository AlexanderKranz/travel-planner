-- Revocable read-only share links. Spec docs/specs/phase-5-share-export.md 1.2.
-- Only the sha256 of the token is stored. Public reads go through the server (secret key) by token hash only.

create or replace function private.is_demo()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select is_demo from public.profiles where id = (select auth.uid())), false)
$$;
revoke execute on function private.is_demo() from public, anon;
grant execute on function private.is_demo() to authenticated;

create table if not exists public.share_links (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  trip_id            uuid not null,
  token_hash         text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label              text check (char_length(label) between 1 and 60),
  include_items      boolean not null default true,
  include_item_notes boolean not null default false, -- notes may hold booking codes: opt-in
  expires_at         timestamptz,
  view_count         integer not null default 0 check (view_count >= 0),
  last_viewed_at     timestamptz,
  created_at         timestamptz not null default now(),
  foreign key (trip_id, owner_id) references public.trips (id, owner_id) on delete cascade,
  constraint share_links_expiry_check check (expires_at is null or expires_at > created_at),
  constraint share_links_notes_need_items check (include_items or not include_item_notes)
);

create index if not exists share_links_trip_idx on public.share_links (trip_id);

alter table public.share_links enable row level security;
revoke all on table public.share_links from anon, authenticated, public;
-- Column grant: token_hash is unreadable for clients. No update privilege (revoke = delete).
grant select (id, trip_id, label, include_items, include_item_notes, expires_at, view_count, last_viewed_at, created_at)
  on public.share_links to authenticated;
grant delete on public.share_links to authenticated;
grant insert (trip_id, token_hash, label, include_items, include_item_notes, expires_at)
  on public.share_links to authenticated;

drop policy if exists "share_links: owner select" on public.share_links;
create policy "share_links: owner select" on public.share_links
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists "share_links: owner insert" on public.share_links;
create policy "share_links: owner insert" on public.share_links
  for insert to authenticated
  with check ((select auth.uid()) = owner_id and not (select private.is_demo()));
drop policy if exists "share_links: owner delete" on public.share_links;
create policy "share_links: owner delete" on public.share_links
  for delete to authenticated using ((select auth.uid()) = owner_id);

-- View counter, called by the server (secret key) after a successful public read.
create or replace function public.share_link_touch(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.share_links set view_count = view_count + 1, last_viewed_at = now() where id = p_id
$$;
revoke all on function public.share_link_touch(uuid) from public, anon, authenticated;
grant execute on function public.share_link_touch(uuid) to service_role;
