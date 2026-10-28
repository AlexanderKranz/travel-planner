-- api_cache: server-only cache of reduced external API results (Open-Meteo, Overpass, Wikivoyage, ...).
-- RLS on, NO grants and NO policies: only the secret key (service_role) reads/writes. Keys may contain
-- search text and coordinates, so not even admins can read it.
-- Expired rows are kept and served as "stale" when a refresh fails; phase 6 cron deletes
-- rows with expires_at < now() - interval '180 days'.

create table if not exists public.api_cache (
  provider    text not null check (provider ~ '^[a-z0-9_]+$'),
  cache_key   text not null check (char_length(cache_key) <= 500),
  payload     jsonb not null check (pg_column_size(payload) < 262144),
  fetched_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  primary key (provider, cache_key)
);

create index if not exists api_cache_expires_at_idx on public.api_cache (expires_at);

alter table public.api_cache enable row level security;
revoke all on table public.api_cache from anon, authenticated, public;
-- No policies on purpose.
