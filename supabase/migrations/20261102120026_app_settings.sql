-- app_settings: runtime settings an admin changes on the admin page (AI switch, budgets, quotas).
-- Server-only like api_cache: RLS on, NO grants for anon/authenticated and NO policies, so only the secret key
-- (service_role) reads and writes. The app checks the admin role before every write (src/lib/server/admin/settings.ts).
-- Never holds secrets: keys are a fixed list of numeric/boolean settings, enforced by the app (Zod) and here by type.
-- Precedence in the app: this value > environment variable > code default. Changes are audited in app_events
-- ('settings.changed', old and new value).

create table if not exists public.app_settings (
  key         text primary key check (key ~ '^[a-z0-9_]{1,60}$'),
  value       jsonb not null check (jsonb_typeof(value) in ('boolean', 'number')),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null
);

alter table public.app_settings enable row level security;
revoke all on table public.app_settings from anon, authenticated, public;
grant select, insert, update, delete on table public.app_settings to service_role;
-- No policies on purpose.
