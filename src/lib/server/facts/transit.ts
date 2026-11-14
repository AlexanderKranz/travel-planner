import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { TransitPart } from "@/lib/domain/tour";
import { fetchPlan, type TransitAnswer } from "@/lib/integrations/transitous";
import { cacheKey, cached, peekCache, type CacheCtx } from "../api-cache";
import { QuotaGuardError } from "../flights-quota";
import { createSupabaseAdminClient } from "../supabase/admin";

/**
 * One public transport leg from Transitous, cached 7 days (spec 17.1 [P3], 17.4). Before a network call the server
 * reserves a `provider_slots` row (daily cap over the last 24 h incl. live slots, one live slot per cache key).
 * No slot, no request (fail closed). A request already in flight for the same leg is awaited through the cache.
 * Never throws: provider trouble is `failed`, which the tour shows as "nicht verfügbar" with walking offered.
 */
export const TRANSIT_TTL_SECONDS = 7 * 86400;
export const TRANSITOUS_DAILY_DEFAULT = 500;
const IN_FLIGHT_WAITS_MS = [1500, 2500, 3000];

export const transitDailyCap = (env: Record<string, string | undefined> = process.env): number => {
  const n = Number(env.TRANSITOUS_DAILY);
  return Number.isInteger(n) && n >= 0 ? n : TRANSITOUS_DAILY_DEFAULT;
};

type Point = { lat: number; lon: number };
const ll = (p: Point) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

/** Points (5 dp) and the local departure with its offset; no owner, so the cache is shared. */
export function transitKey(from: Point, to: Point, departureIso: string): string {
  return cacheKey("transit-plan", 1, { from: ll(from), to: ll(to), time: departureIso });
}

const Answer: z.ZodType<TransitAnswer> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), min: z.number().int().min(0), km: z.number().min(0), poly: z.string(), parts: z.array(TransitPart).min(1) }),
  z.object({ kind: z.literal("walk_not_slower"), min: z.number().int().min(0), km: z.number().min(0), poly: z.string() }),
  z.object({ kind: z.literal("no_connection") }),
]);

export type TransitLegAnswer = (TransitAnswer & { fetchedAt: string; cache: "hit" | "miss" | "stale" }) | { kind: "failed" };

async function reserve(key: string): Promise<{ id: string } | "in_flight"> {
  const { data, error } = await createSupabaseAdminClient().rpc("provider_reserve_slot", {
    p_provider: "transitous",
    p_cache_key: createHash("sha256").update(key).digest("hex"),
    p_daily_cap: transitDailyCap(),
  });
  const r = data as { ok?: boolean; id?: string; reason?: string } | null;
  if (error || !r) throw new QuotaGuardError("transit slot state unavailable");
  if (r.ok && r.id) return { id: r.id };
  if (r.reason === "in_flight") return "in_flight";
  throw new QuotaGuardError("Transitous daily cap reached");
}

async function settle(id: string): Promise<void> {
  try {
    await createSupabaseAdminClient().rpc("provider_settle_slot", { p_id: id });
  } catch {
    // An unsettled slot expires after 2 minutes by itself.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getTransitLeg(
  from: Point,
  to: Point,
  departure: { utcMs: number; iso: string },
  timeZone: string,
  ctx: CacheCtx,
): Promise<TransitLegAnswer> {
  const key = transitKey(from, to, departure.iso);
  let slot: string | null = null;
  let inFlight = false;
  try {
    const res = await cached<TransitAnswer>({
      provider: "transitous",
      endpoint: "plan",
      key,
      ttlSeconds: TRANSIT_TTL_SECONDS,
      schema: Answer,
      ctx,
      fetcher: async () => {
        const r = await reserve(key);
        if (r === "in_flight") {
          inFlight = true;
          throw new QuotaGuardError("Transitous request for this leg already in flight");
        }
        slot = r.id;
        const p = await fetchPlan(from, to, departure, timeZone);
        return { data: p.answer, status: p.status, latencyMs: p.latencyMs };
      },
    });
    if (res.ok) return { ...res.data, fetchedAt: res.fetchedAt, cache: res.cache };
    if (!inFlight) return { kind: "failed" };
    // Another request fetches this leg right now: wait for its cache row instead of a second call.
    for (const ms of IN_FLIGHT_WAITS_MS) {
      await sleep(ms);
      const hit = await peekCache({ provider: "transitous", key, schema: Answer });
      if (hit) return { ...hit.data, fetchedAt: hit.fetchedAt, cache: "hit" };
    }
    return { kind: "failed" };
  } catch {
    return { kind: "failed" };
  } finally {
    if (slot) await settle(slot);
  }
}
