import "server-only";
import type { Locale } from "@/lib/domain/profile";
import { matchLandmarks, sameAsLandmark, type Landmark } from "@/lib/facts/landmarks";
import { AUTOCOMPLETE_LIMIT, normalizeQuery, type PlaceSuggestion } from "@/lib/integrations/geoapify-autocomplete";
import type { CacheCtx } from "../api-cache";
import { autocompletePlaces } from "../facts/place-search";
import { readLandmarks, scheduleLandmarkWarm } from "./landmarks";
import { landmarkPlace, type CityPlace } from "./places";

/**
 * Tour place search (spec 3.1 source 2, landmark fix for issue #172): the city's landmarks first (cached set, matched
 * in code on name, name:de/en, alt/short/official/local names, accent- and case-insensitive), then Geoapify
 * Autocomplete for the rest. `use: "place"` asks Geoapify for POIs only (no addresses, shops, stops, car parks);
 * `use: "endpoint"` (start and end) keeps addresses and hotels. A Geoapify result that is a matched landmark (same
 * name, or one name inside the other, within 300 m: a station's stops and levels) is dropped. For places, a Geoapify
 * result without any category is dropped too once a landmark matched: it cannot be told from a hotel or an
 * information office ("Holiday Inn Frankfurt - Alte Oper", "Tourist Information Römer"); with no landmark match it
 * stays (the Kaiserdom has no category in Geoapify, and the landmark set may not be cached yet). Geoapify is skipped
 * when the landmarks alone fill the list.
 */
export type SearchUse = "place" | "endpoint";

export type TourSearchAnswer =
  | { ok: true; local: CityPlace[]; remote: PlaceSuggestion[]; fetchedAt: string | null }
  | { ok: false; error: "invalid_query" | "unavailable" };

/** Matched landmarks, then the Geoapify results that are not one of them, at most `limit` in total. Pure. */
export function mergeSearch(
  matched: readonly Landmark[],
  remote: readonly PlaceSuggestion[],
  use: SearchUse,
  limit: number = AUTOCOMPLETE_LIMIT,
): { local: Landmark[]; remote: PlaceSuggestion[] } {
  const local = matched.slice(0, limit);
  const rest = remote.filter(
    (r) => !local.some((l) => sameAsLandmark(r, l)) && !(use === "place" && local.length > 0 && !r.category),
  );
  return { local, remote: rest.slice(0, Math.max(0, limit - local.length)) };
}

export async function searchTourPlaces(
  input: { q: string; lat: number; lon: number; lang: Locale; use: SearchUse },
  ctx: CacheCtx,
): Promise<TourSearchAnswer> {
  const centre = { lat: input.lat, lon: input.lon };
  const set = await readLandmarks(centre, ctx);
  if (!set || set.needsWarm) await scheduleLandmarkWarm(centre);
  const matched = set ? matchLandmarks(set.ranked, normalizeQuery(input.q), AUTOCOMPLETE_LIMIT) : [];

  let remote: PlaceSuggestion[] = [];
  let remoteAt: string | null = null;
  if (matched.length < AUTOCOMPLETE_LIMIT) {
    const res = await autocompletePlaces(
      { q: input.q, lat: input.lat, lon: input.lon, lang: input.lang, mode: input.use === "place" ? "poi" : "any" },
      ctx,
    );
    if (!res.ok && (res.error === "invalid_query" || matched.length === 0)) return res;
    if (res.ok) {
      remote = res.suggestions;
      remoteAt = res.fetchedAt;
    }
  }
  const merged = mergeSearch(matched, remote, input.use);
  const dates = [...(merged.local.length && set ? [set.fetchedAt] : []), ...(remoteAt ? [remoteAt] : [])];
  return {
    ok: true,
    local: merged.local.map((l) => landmarkPlace(l, input.lang)),
    remote: merged.remote,
    fetchedAt: dates.length ? [...dates].sort()[0] : null,
  };
}
