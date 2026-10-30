import "server-only";
import { GEOAPIFY_LIMIT, geoapifyCredits } from "@/lib/integrations/geoapify";
import { MAX_INTEREST_QUERIES } from "@/lib/facts/interest-sources";
import { berlinMidnightUtc, QuotaGuardError } from "../flights-quota";
import { createSupabaseAdminClient } from "../supabase/admin";
import { getEffectiveEnv } from "../settings";

/** Default daily credit cap, a margin below the free plan's 3,000 credits/day. */
export const GEOAPIFY_DAILY_CREDITS_DEFAULT = 2000;
/** Most one lookup can cost: three category groups (city sights) at the full page size. */
const MAX_LOOKUP_CREDITS = 3 * geoapifyCredits(GEOAPIFY_LIMIT);
/**
 * Headroom kept free below the cap: credits are logged only after a lookup finishes, so the lookups of one plan
 * (up to MAX_INTEREST_QUERIES in parallel) all read the same total. Cheaper than an atomic reservation, and the
 * default cap sits 1,000 credits below Geoapify's own limit anyway.
 */
export const GEOAPIFY_HEADROOM = MAX_INTEREST_QUERIES * MAX_LOOKUP_CREDITS;
/** PostgREST returns at most 1,000 rows per request; page through the day. */
const PAGE = 1000;

export function geoapifyDailyCap(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.GEOAPIFY_DAILY_CREDITS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : GEOAPIFY_DAILY_CREDITS_DEFAULT;
}

/** Throws QuotaGuardError when today's credits (Berlin day, `units` of the logged calls) plus the headroom
 * would pass the cap. Fails closed; the caller then falls back to Overpass. */
export async function assertGeoapifyQuota(): Promise<void> {
  const cap = geoapifyDailyCap(await getEffectiveEnv());
  let used = 0;
  try {
    const admin = createSupabaseAdminClient();
    const since = berlinMidnightUtc().toISOString();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from("api_calls")
        .select("units")
        .eq("provider", "geoapify")
        .gte("created_at", since)
        .not("units", "is", null)
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error("quota read failed");
      used += (data ?? []).reduce((n, r) => n + (r.units ?? 0), 0);
      if (!data || data.length < PAGE) break;
    }
  } catch {
    throw new QuotaGuardError("Geoapify quota state unavailable");
  }
  if (used + GEOAPIFY_HEADROOM > cap) throw new QuotaGuardError("Geoapify daily cap reached");
}
