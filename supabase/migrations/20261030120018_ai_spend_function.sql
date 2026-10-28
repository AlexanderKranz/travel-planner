-- Server-side sums of ai_usage cost for the budget check. Replaces a client-side sum that PostgREST max_rows
-- (default 1000) would truncate. SECURITY INVOKER on purpose: only service_role (BYPASSRLS) may execute it,
-- so ai_usage stays unreadable for normal users. Called via RPC with the secret key from src/lib/server/ai-usage.ts.
create or replace function public.ai_spend_micro_usd(p_user uuid, p_from timestamptz)
returns table (user_spent bigint, global_spent bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(sum(cost_micro_usd) filter (where user_id = p_user), 0)::bigint,
    coalesce(sum(cost_micro_usd), 0)::bigint
  from public.ai_usage
  where created_at >= p_from;
$$;

revoke all on function public.ai_spend_micro_usd(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.ai_spend_micro_usd(uuid, timestamptz) to service_role;
