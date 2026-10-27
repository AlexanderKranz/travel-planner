-- app_events: errors and key events for the admin page.
-- Written ONLY by server code with the secret key (bypasses RLS) or by security definer triggers.
-- props = metadata only (ids, counts, durations, error classes). Never names, notes, purpose text or emails.

create table if not exists public.app_events (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  level       text not null default 'info' check (level in ('info', 'warn', 'error')),
  event       text not null check (event ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  user_id     uuid references auth.users (id) on delete set null,
  route       text,
  request_id  text,
  props       jsonb not null default '{}'::jsonb check (jsonb_typeof(props) = 'object')
);

create index if not exists app_events_created_at_idx on public.app_events (created_at desc);
create index if not exists app_events_event_idx on public.app_events (event, created_at desc);
create index if not exists app_events_errors_idx on public.app_events (created_at desc) where level = 'error';

alter table public.app_events enable row level security;

revoke all on public.app_events from anon, public;
grant select on public.app_events to authenticated;

drop policy if exists "app_events: admin select" on public.app_events;
create policy "app_events: admin select" on public.app_events
  for select to authenticated using ((select private.is_admin()));
-- No insert/update/delete policies: server writes use the secret key.
