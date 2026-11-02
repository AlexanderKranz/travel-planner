-- In-app feedback to GitHub issues (docs/specs/feedback.md, issue #83). Migration only, additive: the running app
-- does not know this table yet.
-- Writes go through the server only (secret key, after its own checks): users get SELECT on their own rows and
-- nothing else. The per-user limit and the app-wide issue ceiling are enforced atomically by two SECURITY DEFINER
-- functions that only service_role may execute.

-- ---------- feedback ----------
create table if not exists public.feedback (
  id               uuid primary key default gen_random_uuid(),
  -- set by the server (feedback_submit), so no default auth.uid(): the insert runs as service_role
  ref              text not null unique check (ref ~ '^FB-[a-hjkmnp-z2-9]{8}$'),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  kind             text not null check (kind in ('bug', 'idea')),
  -- cleaned text; null once the issue exists (the issue is then the copy)
  body             text check (char_length(body) between 1 and 4000),
  page_path        text check (char_length(page_path) <= 300),
  app_version      text not null check (app_version ~ '^[0-9a-f]{7}$' or app_version = 'local'),
  client           text check (char_length(client) <= 80),
  locale           text not null check (locale in ('de', 'en')),
  screenshot_path  text,
  status           text not null default 'pending' check (status in ('pending', 'created', 'failed')),
  attempts         smallint not null default 0 check (attempts between 0 and 20),
  next_attempt_at  timestamptz not null default now(),
  -- Lease taken by feedback_claim. Separate from next_attempt_at on purpose: a retry back-off (1 h, rate-limit
  -- reset) must not count against the issue ceiling, a live lease must.
  lease_until      timestamptz,
  last_error       text check (char_length(last_error) <= 60),
  issue_number     integer,
  issue_url        text check (issue_url ~ '^https://github\.com/[^/]+/[^/]+/issues/[0-9]+$'),
  issue_created_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint feedback_created_has_issue check (
    status <> 'created' or (issue_number is not null and issue_url is not null and issue_created_at is not null)
  )
);

create index if not exists feedback_owner_created_idx on public.feedback (owner_id, created_at desc);
create index if not exists feedback_pending_due_idx on public.feedback (next_attempt_at) where status = 'pending';
create index if not exists feedback_issue_created_idx on public.feedback (issue_created_at) where status = 'created';
create index if not exists feedback_status_idx on public.feedback (status);

alter table public.feedback enable row level security;
revoke all on table public.feedback from anon, authenticated, public;
-- "My reports" list. No insert/update/delete for users (demo block and limits live in the server, spec D8/D10).
grant select on public.feedback to authenticated;
-- The server (after requireUser / requireAdmin and its own checks) reads and writes with the secret key.
grant select, insert, update, delete on public.feedback to service_role;

drop policy if exists "feedback: owner select" on public.feedback;
create policy "feedback: owner select" on public.feedback
  for select to authenticated using ((select auth.uid()) = owner_id);
-- No admin policy: admin reads use the secret key after the admin check.

drop trigger if exists feedback_set_updated_at on public.feedback;
create trigger feedback_set_updated_at
  before update on public.feedback
  for each row execute function private.set_updated_at();

-- ---------- feedback_submit: per-user daily limit, atomic ----------
-- Counts the owner's rows since Berlin midnight and inserts only below p_limit, under a per-user advisory lock, so
-- parallel requests cannot all see the same remaining capacity. Returns ('limited', null) without inserting at the
-- limit, otherwise ('created', id). A duplicate ref raises unique_violation (23505): the server retries once with a
-- new ref. The caller must have validated and cleaned the input; the table checks are the last line of defence.
create or replace function public.feedback_submit(
  p_owner       uuid,
  p_ref         text,
  p_kind        text,
  p_body        text,
  p_page_path   text,
  p_app_version text,
  p_client      text,
  p_locale      text,
  p_limit       integer
)
returns table (outcome text, feedback_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_midnight timestamptz := date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin';
  v_count    integer;
  v_id       uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('feedback:user:' || p_owner::text));

  select count(*) into v_count
    from public.feedback f
   where f.owner_id = p_owner and f.created_at >= v_midnight;

  if p_limit is null or v_count >= p_limit then
    return query select 'limited'::text, null::uuid;
    return;
  end if;

  insert into public.feedback (ref, owner_id, kind, body, page_path, app_version, client, locale)
  values (p_ref, p_owner, p_kind, p_body, p_page_path, p_app_version, p_client, p_locale)
  returning id into v_id;

  return query select 'created'::text, v_id;
end;
$$;

revoke all on function public.feedback_submit(uuid, text, text, text, text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.feedback_submit(uuid, text, text, text, text, text, text, text, integer)
  to service_role;

-- ---------- feedback_claim: lease one pending row below the app-wide issue ceiling, atomic ----------
-- Used = issues created since Berlin midnight + pending rows with a live lease. Leases the row only if used is below
-- p_ceiling and the row is due (pending, next_attempt_at <= now(), no live lease). Sets the lease and
-- next_attempt_at to now() + 10 min and attempts + 1, and returns the row; returns nothing otherwise. A failed attempt
-- keeps its lease until it expires. p_ceiling is the resolved admin setting feedback_daily_issues (0 pauses).
create or replace function public.feedback_claim(p_id uuid, p_ceiling integer)
returns setof public.feedback
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_midnight timestamptz := date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin';
  v_used     integer;
begin
  if p_ceiling is null or p_ceiling <= 0 then
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('feedback:issues'));

  select count(*) into v_used
    from public.feedback f
   where (f.status = 'created' and f.issue_created_at >= v_midnight)
      or (f.status = 'pending' and f.lease_until > now());

  if v_used >= p_ceiling then
    return;
  end if;

  return query
    update public.feedback f
       set lease_until = now() + interval '10 minutes',
           next_attempt_at = now() + interval '10 minutes',
           attempts = f.attempts + 1
     where f.id = p_id
       and f.status = 'pending'
       and f.next_attempt_at <= now()
       and (f.lease_until is null or f.lease_until <= now())
       and f.attempts < 20
    returning f.*;
end;
$$;

revoke all on function public.feedback_claim(uuid, integer) from public, anon, authenticated;
grant execute on function public.feedback_claim(uuid, integer) to service_role;

-- ---------- Storage bucket for screenshots (spec D9) ----------
-- Private, 2 MB, png/jpeg/webp. storage.objects has RLS on and we add NO policies, so anon/authenticated can do
-- nothing; only the secret key (service_role) reads and writes. Guarded because the storage schema belongs to the
-- storage service (CI starts the stack without it).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('feedback-screenshots', 'feedback-screenshots', false, 2097152,
            array['image/jpeg', 'image/webp', 'image/png'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end
$$;
