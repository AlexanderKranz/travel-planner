import "server-only";
import { GEOAPIFY_LIMIT, geoapifyCredits } from "@/lib/integrations/geoapify";
import { berlinMidnightUtc, QuotaGuardError } from "../flights-quota";
import { createSupabaseAdminClient } from "../supabase/admin";
import { getEffectiveEnv } from "../settings";

/** Default daily credit cap, a margin below the free plan's 3,000 credits/day. */
export const GEOAPIFY_DAILY_CREDITS_DEFAULT = 2000;
/** Most one lookup can cost: two category groups at the full page size. */
const MAX_LOOKUP_CREDITS = 2 * geoapifyCredits(GEOAPIFY_LIMIT);

export function geoapifyDailyCap(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.GEOAPIFY_DAILY_CREDITS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : GEOAPIFY_DAILY_CREDITS_DEFAULT;
}

/**
 * Throws QuotaGuardError when today's credits (Berlin day, `units` of the logged calls) plus one more lookup
 * would pass the cap. Fails closed; the caller then falls back to Overpass.
 */
export async function assertGeoapifyQuota(): Promise<void> {
  const cap = geoapifyDailyCap(await getEffectiveEnv());
  let used: number;
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("api_calls")
      .select("units")
      .eq("provider", "geoapify")
      .gte("created_at", berlinMidnightUtc().toISOString())
      .not("units", "is", null);
    if (error) throw new Error("quota read failed");
    used = (data ?? []).reduce((n, r) => n + (r.units ?? 0), 0);
  } catch {
    throw new QuotaGuardError("Geoapify quota state unavailable");
  }
  if (used + MAX_LOOKUP_CREDITS > cap) throw new QuotaGuardError("Geoapify daily cap reached");
}
