-- ai_usage: one metadata row per Claude call (never prompt or response content). Written by the server
-- with the secret key (bypasses RLS, see src/lib/server/ai-usage.ts). Users read their own rows, admins all.

create table if not exists public.ai_usage (
  id                           bigint generated always as identity primary key,
  created_at                   timestamptz not null default now(),
  user_id                      uuid references auth.users (id) on delete set null,
  task                         text not null check (task in ('purpose_tags', 'plan_generate', 'plan_patch')),
  model                        text not null check (model ~ '^[a-z0-9.-]+$' and char_length(model) <= 60),
  status                       text not null check (status in ('ok', 'refusal', 'max_tokens', 'invalid_output', 'error')),
  input_tokens                 integer not null default 0 check (input_tokens >= 0),
  output_tokens                integer not null default 0 check (output_tokens >= 0),
  cache_creation_input_tokens  integer not null default 0 check (cache_creation_input_tokens >= 0),
  cache_read_input_tokens      integer not null default 0 check (cache_read_input_tokens >= 0),
  cost_micro_usd               integer not null default 0 check (cost_micro_usd >= 0),
  latency_ms                   integer,
  is_demo                      boolean not null default false,
  error_code                   text check (char_length(error_code) <= 60)
);

create index if not exists ai_usage_user_idx on public.ai_usage (user_id, created_at desc);
create index if not exists ai_usage_created_at_idx on public.ai_usage (created_at desc);

alter table public.ai_usage enable row level security;
revoke all on table public.ai_usage from anon, authenticated, public;
grant select on public.ai_usage to authenticated;

drop policy if exists "ai_usage: owner select" on public.ai_usage;
create policy "ai_usage: owner select" on public.ai_usage
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "ai_usage: admin select" on public.ai_usage;
create policy "ai_usage: admin select" on public.ai_usage
  for select to authenticated using ((select private.is_admin()));
-- No insert/update/delete policies: server writes use the secret key.
