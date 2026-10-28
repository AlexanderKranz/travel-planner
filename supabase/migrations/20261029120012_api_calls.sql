-- api_calls: one metadata row per external API lookup (cache hit/miss/stale/bypass) for the admin page.
-- No cache keys, query text or coordinates (admins read this table). Written by the server with the
-- secret key (bypasses RLS). Retention 90 days (phase 6 cron).

create table if not exists public.api_calls (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  provider         text not null check (provider ~ '^[a-z0-9_]+$'),
  endpoint         text not null check (endpoint ~ '^[a-z0-9_]+$'),
  cache            text not null check (cache in ('hit', 'miss', 'stale', 'bypass')),
  status           smallint,
  ok               boolean not null,
  latency_ms       integer,
  units            integer,
  quota_remaining  integer,
  error_code       text check (char_length(error_code) <= 60),
  user_id          uuid references auth.users (id) on delete set null
);

create index if not exists api_calls_created_at_idx on public.api_calls (created_at desc);
create index if not exists api_calls_provider_idx on public.api_calls (provider, created_at desc);

alter table public.api_calls enable row level security;
revoke all on table public.api_calls from anon, authenticated, public;
grant select on public.api_calls to authenticated;

drop policy if exists "api_calls: admin select" on public.api_calls;
create policy "api_calls: admin select" on public.api_calls
  for select to authenticated using ((select private.is_admin()));
-- No insert/update/delete policies: server writes use the secret key.
