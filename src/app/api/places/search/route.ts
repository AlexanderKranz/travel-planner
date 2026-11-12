import { NextResponse } from "next/server";
import { z } from "zod";
import type { TourSuggestion } from "@/lib/domain/tour";
import { haversineKm } from "@/lib/facts/places";
import { AUTOCOMPLETE_MAX_CHARS, AUTOCOMPLETE_MIN_CHARS } from "@/lib/integrations/geoapify-autocomplete";
import { reserveAiCall } from "@/lib/server/ai-slots";
import { berlinMidnight } from "@/lib/server/ai-usage";
import { rateLimit } from "@/lib/server/rate-limit";
import { getUserSession } from "@/lib/server/session";
import { signPointRef } from "@/lib/server/tour/point-ref";
import { searchTourPlaces } from "@/lib/server/tour/search";

/** Spec city-tour 3.1: 30 per minute and 200 per Berlin day per user. */
const SEARCH_PER_MIN = 30;
const SEARCH_PER_DAY = 200;

const querySchema = z.object({
  q: z.string().trim().min(AUTOCOMPLETE_MIN_CHARS).max(AUTOCOMPLETE_MAX_CHARS),
  // Non-empty before coercion: `z.coerce.number()` would turn "" into 0 (a search around 0,0).
  lat: z.string().trim().min(1).pipe(z.coerce.number<string>().min(-90).max(90)),
  lon: z.string().trim().min(1).pipe(z.coerce.number<string>().min(-180).max(180)),
  lang: z.enum(["de", "en"]).default("de"),
  /** `endpoint`: start and end of a tour (addresses and hotels allowed); default `place`: sights only. */
  use: z.enum(["place", "endpoint"]).default("place"),
});

const NO_STORE = { "Cache-Control": "no-store" };

/** Straight-line metres from the search centre (shown like Geoapify's `distance`). */
function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return haversineKm(a, b) * 1000;
}

/** "tourism.attraction" → "attraction" (icon category, at most 40 characters). */
const catOf = (c: string | undefined) => (c ? (c.split(".").pop() ?? c).slice(0, 40) : undefined);

/**
 * GET /api/places/search?q=steph&lat=48.21&lon=16.37&lang=de[&use=endpoint] → `{ results: TourSuggestion[] }` (city
 * tour place search, spec 3.1 source 2). Login required. Up to 8 results: the city's cached landmarks that match
 * (OSM, by prominence), then Geoapify Autocomplete within 20 km of the point (POIs only for places, addresses too for
 * `use=endpoint`), cached 30 days per normalized query, 2-decimal cell, language and mode. A landmark cache miss
 * schedules the landmark warm-up after the response (no Overpass inline). Each result carries a signed `ref`, the only way
 * createTour / updateTour accept it (the browser never supplies coordinates). Errors: 401 `unauthorized`,
 * 400 `invalid_query`, 429 `rate_limited` / `daily_limit` (Retry-After), 503 `unavailable` (limits unreadable);
 * 200 with `error: "unavailable"` and no results when Geoapify is down or its credits are used up.
 */
export async function GET(request: Request) {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  // Cheap per-instance guard first, then the durable per-user count (atomic across instances).
  const rl = rateLimit(`place-search:${session.userId}`, SEARCH_PER_MIN, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { results: [], error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ results: [], error: "invalid_query" }, { status: 400, headers: NO_STORE });

  // `ai_call_slots` holds generic per-user/task counters (user, task, time; no content), task "place_search".
  const now = new Date();
  try {
    const slot = await reserveAiCall({
      userId: session.userId,
      task: "place_search",
      perMinute: SEARCH_PER_MIN,
      perDay: SEARCH_PER_DAY,
      dayStart: berlinMidnight(now),
    });
    if (!slot.ok) {
      const day = slot.reason === "day";
      const retry = day ? Math.max(1, Math.ceil((berlinMidnight(now, 1).getTime() - now.getTime()) / 1000)) : 60;
      return NextResponse.json(
        { results: [], error: day ? "daily_limit" : "rate_limited" },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(retry) } },
      );
    }
  } catch {
    return NextResponse.json({ results: [], error: "unavailable" }, { status: 503, headers: NO_STORE });
  }

  const res = await searchTourPlaces(parsed.data, { userId: session.userId });
  if (!res.ok) {
    return res.error === "invalid_query"
      ? NextResponse.json({ results: [], error: "invalid_query" }, { status: 400, headers: NO_STORE })
      : NextResponse.json({ results: [], error: "unavailable" }, { headers: NO_STORE });
  }
  try {
    // Landmarks: OSM points with their `osm:` key, signed like the suggestions (nothing left to resolve on save).
    const local: TourSuggestion[] = res.local.map((p) => {
      const point = { key: p.key, name: p.name, lat: p.lat, lon: p.lon, source: "osm" as const, cat: p.cat };
      const d = Math.round(distanceM(parsed.data, p));
      return { ...point, ref: signPointRef(point), distanceM: d };
    });
    const remote: TourSuggestion[] = res.remote.map((s) => {
      const point = { key: s.key, name: s.name, lat: s.lat, lon: s.lon, source: "geoapify" as const, ...(catOf(s.category) ? { cat: catOf(s.category) } : {}) };
      return {
        ...point,
        ref: signPointRef(point, { id: s.placeId, osm: s.datasource === "openstreetmap" }),
        ...(s.address ? { address: s.address } : {}),
        ...(s.distanceM !== undefined ? { distanceM: Math.round(s.distanceM) } : {}),
      };
    });
    return NextResponse.json({ results: [...local, ...remote], fetchedAt: res.fetchedAt }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ results: [], error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
