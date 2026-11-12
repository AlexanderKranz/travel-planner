import "server-only";
import { createHash } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import {
  LANDMARK_FILTERS,
  LANDMARK_RADIUS_KM,
  collectLandmarks,
  rankLandmarks,
  type Landmark,
} from "@/lib/facts/landmarks";
import { buildQuery, runQuery } from "@/lib/integrations/overpass";
import { fetchSitelinkCounts } from "@/lib/integrations/wikidata-sitelinks";
import { landmarksJob } from "@/lib/places-retry";
import { cacheKey, cached, type CacheCtx, type CachedResult } from "../api-cache";
import { enqueuePlaceRetries } from "../place-retries";

/**
 * City landmarks for city tours (spec docs/specs/city-tour.md, implementation notes "Landmarks"): one Overpass query
 * per city point (all landmark categories, wikidata only, 8 km) and one sitelink lookup on Wikidata for the ranking.
 *
 * Overpass is never queried inside a user request (25-60 s, at times 280 s on a mirror): user paths read the cache
 * only (`readLandmarks`), and a miss schedules the warm-up after the response (`scheduleLandmarkWarm`, Next.js
 * `after`) plus the place retry job as a fallback. Wikidata answers in ~250 ms per 50 ids and is only called in the
 * same warm-up, never inline either.
 *
 * Cache keys: `landmarks:v1:lat=…;lon=…;r=8` (overpass, 30 d) and `sitelinks:v1:ids=<hash>;lat=…;lon=…;r=8`
 * (wikidata, 90 d; the hash of the set's ids, so a refreshed set with other ids fetches its counts again), anchor
 * rounded to 3 decimals like the interest places. Shared across users (public places only). A complete set is also
 * kept in memory for READ_MEMO_MS per instance: Wien's set is ~340 KB and the search reads it on every keystroke.
 */
export const LANDMARKS_TTL_SECONDS = 30 * 86400;
export const SITELINKS_TTL_SECONDS = 90 * 86400;
/** Overpass element cap: Wien within 8 km had 1,739 matching elements (2026-11-12). */
export const LANDMARK_QUERY_LIMIT = 3000;
/** Budget of the warm-up after a response (the retry worker passes its own). */
export const LANDMARK_WARM_BUDGET_MS = 110_000;
/** One warm-up per city point and instance in this window (a search sends a request per keystroke). */
export const WARM_COOLDOWN_MS = 10 * 60_000;
/** A complete (fresh, ranked) set is read from the cache at most this often per point and instance. */
export const READ_MEMO_MS = 5 * 60_000;
const READ_MEMO_MAX = 20;

export type Anchor = { lat: number; lon: number };
export const anchorOf = (p: Anchor): Anchor => ({ lat: Number(p.lat.toFixed(3)), lon: Number(p.lon.toFixed(3)) });

export const landmarksKey = (p: Anchor) => {
  const a = anchorOf(p);
  return cacheKey("landmarks", 1, { lat: a.lat, lon: a.lon, r: LANDMARK_RADIUS_KM });
};
/** Sitelinks key: the anchor plus a hash of the set's Wikidata ids (sorted), 16 hex characters. */
export const sitelinksKey = (p: Anchor, ids: readonly string[]) => {
  const a = anchorOf(p);
  const h = createHash("sha256").update([...new Set(ids)].sort().join(",")).digest("hex").slice(0, 16);
  return cacheKey("sitelinks", 1, { ids: h, lat: a.lat, lon: a.lon, r: LANDMARK_RADIUS_KM });
};

const LandmarkSchema: z.ZodType<Landmark> = z.object({
  osmType: z.enum(["node", "way", "relation"]),
  osmId: z.number().int().positive(),
  name: z.string().min(1).max(120),
  names: z.object({ de: z.string().max(120).optional(), en: z.string().max(120).optional() }),
  alt: z.array(z.string().max(120)).max(12),
  cat: z.string().min(1).max(40),
  kind: z.enum(["sight", "station", "street", "memorial", "market", "green", "building"]),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  distanceKm: z.number().min(0),
  wikidata: z.string().regex(/^Q\d{1,12}$/),
  wikipedia: z.boolean(),
  nameCount: z.number().int().min(0),
});
const LandmarksSchema = z.array(LandmarkSchema);
const SitelinksSchema = z.record(z.string().regex(/^Q\d{1,12}$/), z.number().int().min(0));

function landmarksLookup(anchor: Anchor, ctx: CacheCtx, deadline: number | null): Promise<CachedResult<Landmark[]>> {
  return cached({
    provider: "overpass",
    endpoint: "landmarks",
    key: landmarksKey(anchor),
    ttlSeconds: LANDMARKS_TTL_SECONDS,
    schema: LandmarksSchema,
    ctx,
    fetchAllowed: () => deadline !== null,
    fetcher: async () => {
      const r = await runQuery(buildQuery(LANDMARK_FILTERS, anchor, LANDMARK_RADIUS_KM * 1000, LANDMARK_QUERY_LIMIT), {
        deadline: deadline ?? Date.now(),
      });
      return { data: collectLandmarks(r.elements, anchor), status: r.status, latencyMs: r.latencyMs, variant: r.mirror };
    },
  });
}

function sitelinksLookup(
  anchor: Anchor,
  landmarks: readonly Landmark[],
  ctx: CacheCtx,
  deadline: number | null,
): Promise<CachedResult<Record<string, number>>> {
  return cached({
    provider: "wikidata",
    endpoint: "sitelinks",
    key: sitelinksKey(anchor, landmarks.map((l) => l.wikidata)),
    ttlSeconds: SITELINKS_TTL_SECONDS,
    schema: SitelinksSchema,
    ctx,
    fetchAllowed: () => deadline !== null,
    fetcher: async () => {
      // `collectLandmarks` already keeps at most MAX_LANDMARK_CANDIDATES (≤ 20 requests of 50).
      const r = await fetchSitelinkCounts(landmarks.map((l) => l.wikidata), { deadline: deadline ?? Date.now() });
      return { data: r.counts, status: r.status, latencyMs: r.latencyMs, units: r.requests };
    },
  });
}

export type CityLandmarks = {
  /** Ranked by prominence (sitelinks, or the fallback while they are missing). */
  ranked: Landmark[];
  /** Overpass check date of the set. */
  fetchedAt: string;
  /** Ranked by sitelinks (also true for an empty set); false = fallback order until Wikidata answered. */
  prominence: boolean;
  /** Sitelinks missing or either entry expired: a warm-up is due. */
  needsWarm: boolean;
};

const memo = new Map<string, { at: number; value: CityLandmarks }>();

/** The cached landmark set of a city point, ranked; null when it was never fetched. 0 external calls. */
export async function readLandmarks(anchor: Anchor, ctx: CacheCtx, now: number = Date.now()): Promise<CityLandmarks | null> {
  const a = anchorOf(anchor);
  const key = landmarksKey(a);
  const hit = memo.get(key);
  if (hit && now - hit.at < READ_MEMO_MS) return hit.value;
  const set = await landmarksLookup(a, ctx, null);
  if (!set.ok) return null;
  const links = set.data.length ? await sitelinksLookup(a, set.data, ctx, null) : null;
  const sitelinks = links?.ok ? links.data : null;
  const value: CityLandmarks = {
    ranked: rankLandmarks(set.data, sitelinks),
    fetchedAt: set.fetchedAt,
    prominence: set.data.length === 0 || sitelinks !== null,
    needsWarm: set.stale || (set.data.length > 0 && (!links?.ok || links.stale)),
  };
  if (!value.needsWarm) {
    memo.delete(key);
    memo.set(key, { at: now, value });
    if (memo.size > READ_MEMO_MAX) memo.delete(memo.keys().next().value!);
  }
  return value;
}

const inFlight = new Map<string, Promise<"ok" | "failed">>();

/**
 * Fetches what is missing or expired: Overpass first (one query), then the sitelink counts. For the warm-up and the
 * place retry worker only, never inline in a user request. Concurrent calls for one point share a promise. Never throws.
 */
export function warmLandmarks(anchor: Anchor, ctx: CacheCtx, budgetMs: number): Promise<"ok" | "failed"> {
  const a = anchorOf(anchor);
  const key = landmarksKey(a);
  const running = inFlight.get(key);
  if (running) return running;
  const p = (async (): Promise<"ok" | "failed"> => {
    try {
      const deadline = Date.now() + budgetMs;
      // A refresh that failed serves the expired entry (`stale`): not done, the job tries again.
      const set = await landmarksLookup(a, ctx, deadline);
      if (!set.ok || set.stale) return "failed";
      if (set.data.length) {
        const links = await sitelinksLookup(a, set.data, ctx, deadline);
        if (!links.ok || links.stale) return "failed";
      }
      // cached() reports a failed cache write only in its log: done only when the stored set reads back complete.
      memo.delete(key);
      const stored = await readLandmarks(a, ctx);
      return stored && !stored.needsWarm ? "ok" : "failed";
    } catch {
      return "failed";
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

const lastWarm = new Map<string, number>();

/**
 * After a cache miss (or an incomplete set) in a user request: warm the landmarks after the response, and queue the
 * retry job in case this instance stops first (the job dedupes by key). At most once per point and instance per
 * WARM_COOLDOWN_MS. `after` only: the user's response never waits for Overpass.
 */
export async function scheduleLandmarkWarm(anchor: Anchor, now: number = Date.now()): Promise<void> {
  const a = anchorOf(anchor);
  const key = landmarksKey(a);
  const last = lastWarm.get(key);
  if (last !== undefined && now - last < WARM_COOLDOWN_MS) return;
  lastWarm.set(key, now);
  if (lastWarm.size > 500) lastWarm.delete(lastWarm.keys().next().value!);
  await enqueuePlaceRetries([landmarksJob(a)]);
  try {
    after(async () => {
      await warmLandmarks(a, { userId: null }, LANDMARK_WARM_BUDGET_MS);
    });
  } catch {
    // after() unavailable (outside a request scope): the retry job does it.
  }
}

/** Test hook: forget the per-instance cooldowns and the read memo. */
export function resetLandmarkWarmState(): void {
  lastWarm.clear();
  inFlight.clear();
  memo.clear();
}
