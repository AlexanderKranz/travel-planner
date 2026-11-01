import "server-only";
import { berlinMidnightUtc, QuotaGuardError } from "../flights-quota";
import { createSupabaseAdminClient } from "../supabase/admin";
import { getEffectiveEnv } from "../settings";

/**
 * Default daily request cap for matrix and Directions calls together. The plan allows 500 matrix and 2000 Directions
 * requests a day (dashboard, 2026-11-01); 200 is a cautious shared cap, raise it in the admin settings if needed. A drive search is refused below
 * 8 + 50 requests left, so 142 are usable for searches and plans keep at least their reserve.
 */
export const ORS_DAILY_REQUESTS_DEFAULT = 200;

export function orsDailyCap(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.ORS_DAILY_REQUESTS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : ORS_DAILY_REQUESTS_DEFAULT;
}

/**
 * ORS network requests since Berlin midnight, from `api_calls` (cache hits excluded). Every ORS call of the app is
 * counted here, plans (matrix) and destination searches (directions) alike: one cap guards both. SECRET KEY (RLS
 * bypass) on purpose: `api_calls` has no user grants and this is an aggregate count, no row content.
 * Throws QuotaGuardError when the count cannot be read (callers fail closed).
 */
async function orsRequestsToday(): Promise<number> {
  try {
    const admin = createSupabaseAdminClient();
    const { count, error } = await admin
      .from("api_calls")
      .select("id", { count: "exact", head: true })
      .eq("provider", "openrouteservice")
      .neq("cache", "hit")
      .gte("created_at", berlinMidnightUtc().toISOString());
    if (error) throw new Error("quota read failed");
    return count ?? 0;
  } catch {
    throw new QuotaGuardError("ORS quota state unavailable");
  }
}

/** Throws QuotaGuardError when today's network requests (Berlin day) reached the cap. Fails closed. */
export async function assertOrsQuota(): Promise<void> {
  const cap = orsDailyCap(await getEffectiveEnv());
  if ((await orsRequestsToday()) >= cap) throw new QuotaGuardError("ORS daily cap reached");
}

/** Requests left today; 0 when the count cannot be read (fails closed). */
export async function orsRequestsLeft(): Promise<number> {
  try {
    const cap = orsDailyCap(await getEffectiveEnv());
    return Math.max(0, cap - (await orsRequestsToday()));
  } catch {
    return 0;
  }
}
