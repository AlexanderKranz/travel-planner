-- Durable per-user limits for AI calls, atomic across server instances (docs/specs/itinerary-upload.md [D9]).
--
-- Before this, the limits read `ai_usage` (which only grows when a call finishes) and an in-memory counter per
-- server instance, so overlapping requests on different instances could each pass the gate. ai_reserve_call takes
-- a per-user/task advisory lock, counts the slots in the last minute and since the given day start, and inserts a
-- new slot only when both limits allow it. The budget check then reserves for the slots still pending.
--
-- A slot holds no content: user, task name and timestamps. RLS is on and there are NO policies: only the secret key
-- (service_role) reads and writes it. Slots older than 2 days are removed by the next reservation of that user/task.

create table if not exists public.ai_call_slots (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  task        text not null check (task ~ '^[a-z_]{1,40}$'),
  created_at  timestamptz not null default now(),
  -- Set when the call finished (successfully or not); a slot without it is pending and holds budget.
  settled_at  timestamptz
);

create index if not exists ai_call_slots_user_task_idx on public.ai_call_slots (user_id, task, created_at desc);

alter table public.ai_call_slots enable row level security;
revoke all on table public.ai_call_slots from anon, authenticated, public;
grant select, insert, update, delete on public.ai_call_slots to service_role;
-- No policies on purpose.

-- ---------- ai_reserve_call: take one slot if the minute and day limits allow it ----------
-- Returns {ok: true, id, pending} (pending = other unsettled slots of the last 10 minutes, for the budget reserve)
-- or {ok: false, reason: 'minute' | 'day'}.
create or replace function public.ai_reserve_call(
  p_user uuid, p_task text, p_minute_limit integer, p_day_limit integer, p_day_start timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_minute integer;
  v_day integer;
  v_pending integer;
  v_id uuid;
begin
  if p_user is null or p_task is null or p_minute_limit is null or p_day_limit is null or p_day_start is null then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  -- Serializes reservations of one user and task; released at the end of the transaction (this call).
  perform pg_advisory_xact_lock(hashtextextended('ai_call_slots:' || p_user::text || ':' || p_task, 0));

  delete from public.ai_call_slots
   where user_id = p_user and task = p_task and created_at < now() - interval '2 days';

  select count(*) filter (where created_at > now() - interval '1 minute'),
         count(*) filter (where created_at >= p_day_start),
         count(*) filter (where settled_at is null and created_at > now() - interval '10 minutes')
    into v_minute, v_day, v_pending
    from public.ai_call_slots
   where user_id = p_user and task = p_task;

  if v_minute >= p_minute_limit then
    return jsonb_build_object('ok', false, 'reason', 'minute');
  end if;
  if v_day >= p_day_limit then
    return jsonb_build_object('ok', false, 'reason', 'day');
  end if;

  insert into public.ai_call_slots (user_id, task) values (p_user, p_task) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'pending', v_pending);
end;
$$;

-- ---------- ai_settle_call: the call finished; the slot keeps counting but no longer holds budget ----------
create or replace function public.ai_settle_call(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.ai_call_slots set settled_at = now() where id = p_id and settled_at is null;
$$;

-- ---------- ai_release_call: the call never happened (e.g. budget refused); give the slot back ----------
create or replace function public.ai_release_call(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.ai_call_slots where id = p_id and settled_at is null;
$$;

revoke all on function public.ai_reserve_call(uuid, text, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.ai_settle_call(uuid) from public, anon, authenticated;
revoke all on function public.ai_release_call(uuid) from public, anon, authenticated;
grant execute on function public.ai_reserve_call(uuid, text, integer, integer, timestamptz) to service_role;
grant execute on function public.ai_settle_call(uuid) to service_role;
grant execute on function public.ai_release_call(uuid) to service_role;
