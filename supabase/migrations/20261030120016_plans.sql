-- plans (one per trip) + plan_versions (append-only). Spec docs/specs/phase-3-ai-plan.md section 1.2/1.3.

-- Target of the composite FK plans (trip_id, owner_id) -> trips (id, owner_id).
alter table public.trips
  add constraint trips_id_owner_key unique (id, owner_id);

create table if not exists public.plans (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  trip_id         uuid not null unique,
  latest_version  integer not null default 0 check (latest_version >= 0),
  busy_until      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (trip_id, owner_id) references public.trips (id, owner_id) on delete cascade,
  constraint plans_id_owner_key unique (id, owner_id)
);

alter table public.plans enable row level security;
revoke all on table public.plans from anon, authenticated, public;
grant select, delete on public.plans to authenticated;
-- owner_id comes from its default (auth.uid()); latest_version is set by the version trigger only.
grant insert (trip_id) on public.plans to authenticated;
grant update (busy_until) on public.plans to authenticated;

drop policy if exists "plans: owner select" on public.plans;
create policy "plans: owner select" on public.plans
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists "plans: owner insert" on public.plans;
create policy "plans: owner insert" on public.plans
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists "plans: owner update" on public.plans;
create policy "plans: owner update" on public.plans
  for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "plans: owner delete" on public.plans;
create policy "plans: owner delete" on public.plans
  for delete to authenticated using ((select auth.uid()) = owner_id);

drop trigger if exists plans_set_updated_at on public.plans;
create trigger plans_set_updated_at
  before update on public.plans
  for each row execute function private.set_updated_at();

create table if not exists public.plan_versions (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  plan_id         uuid not null,
  version_no      integer not null,
  kind            text not null check (kind in ('generate', 'patch', 'edit', 'restore')),
  plan            jsonb not null check (jsonb_typeof(plan) = 'object' and pg_column_size(plan) < 262144),
  input           jsonb not null check (jsonb_typeof(input) = 'object' and pg_column_size(input) < 131072),
  input_hash      text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  feedback        jsonb check (feedback is null or pg_column_size(feedback) < 4096),
  restored_from   integer,
  changed_days    smallint[] not null default '{}',
  model           text check (char_length(model) <= 60),
  cost_micro_usd  integer not null default 0 check (cost_micro_usd >= 0),
  created_at      timestamptz not null default now(),
  foreign key (plan_id, owner_id) references public.plans (id, owner_id) on delete cascade,
  constraint plan_versions_no_key unique (plan_id, version_no)
);

create index if not exists plan_versions_plan_idx on public.plan_versions (plan_id, version_no desc);
create index if not exists plan_versions_hash_idx on public.plan_versions (owner_id, input_hash);

alter table public.plan_versions enable row level security;
revoke all on table public.plan_versions from anon, authenticated, public;
grant select, delete on public.plan_versions to authenticated;
-- No update grant: versions are immutable. version_no and owner_id are never insertable.
grant insert (plan_id, kind, plan, input, input_hash, feedback, restored_from, changed_days, model, cost_micro_usd)
  on public.plan_versions to authenticated;

drop policy if exists "plan_versions: owner select" on public.plan_versions;
create policy "plan_versions: owner select" on public.plan_versions
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists "plan_versions: owner insert" on public.plan_versions;
create policy "plan_versions: owner insert" on public.plan_versions
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists "plan_versions: owner delete" on public.plan_versions;
create policy "plan_versions: owner delete" on public.plan_versions
  for delete to authenticated using ((select auth.uid()) = owner_id);

-- Assigns version_no atomically. The row lock on plans serializes concurrent inserts.
-- SECURITY DEFINER because users have no update grant on latest_version; it only touches the row
-- named by new.plan_id AND new.owner_id (the composite FK then proves the plan really belongs to the owner).
create or replace function private.plan_versions_assign_no()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.plans
     set latest_version = latest_version + 1, updated_at = now()
   where id = new.plan_id and owner_id = new.owner_id
  returning latest_version into new.version_no;
  if new.version_no is null then
    raise exception 'plan not found' using errcode = '23503';
  end if;
  return new;
end;
$$;
revoke all on function private.plan_versions_assign_no() from public, anon, authenticated;

drop trigger if exists plan_versions_assign_no on public.plan_versions;
create trigger plan_versions_assign_no
  before insert on public.plan_versions
  for each row execute function private.plan_versions_assign_no();
