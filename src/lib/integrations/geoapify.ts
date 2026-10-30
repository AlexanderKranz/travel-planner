/**
 * Geoapify Places API (OpenStreetMap data, keyed). Docs: https://apidocs.geoapify.com/docs/places/ (checked
 * 2026-10-30). Used as the fast primary source for places; Overpass stays the fallback (see facts/places.ts).
 * Spike 2026-10-30 (7 destination/interest pairs): 0.6-1.1 s per request (one 8 s), Overpass 25-47 s or 5xx.
 * Free plan: 3,000 credits/day; one credit per 20 places returned. Each feature carries the full OSM tags in
 * `properties.datasource.raw` (osm_type "n"|"w"|"r", osm_id, wikidata, website ...), so the same OSM filters as
 * the Overpass query can be applied in code. Data: © OpenStreetMap contributors (ODbL), powered by Geoapify.
 * The key is read from `GEOAPIFY_API_KEY` only here and never logged (HttpError messages carry no URL).
 */
import "server-only";
import { z } from "zod";
import { fetchJson } from "./http";
import type { RawOsmElement } from "./overpass";

export const GEOAPIFY_PLACES_URL = "https://api.geoapify.com/v2/places";
export const GEOAPIFY_TIMEOUT_MS = 15_000;
/** Places per request: the categories are a superset of the OSM filters, so fetch more than we keep (5 credits). */
export const GEOAPIFY_LIMIT = 100;
/** Geoapify bills one credit per started block of 20 places. */
export const geoapifyCredits = (places: number) => Math.max(1, Math.ceil(places / 20));

const OSM_TYPES = { n: "node", w: "way", r: "relation" } as const;

const Feature = z.object({
  properties: z.object({
    lat: z.number(),
    lon: z.number(),
    datasource: z
      .object({
        raw: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  }),
});
const Response = z.object({ features: z.array(Feature) });

export function hasGeoapifyKey(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.GEOAPIFY_API_KEY?.trim());
}

export function placesUrl(categories: readonly string[], center: { lat: number; lon: number }, radiusM: number, key: string): string {
  const u = new URL(GEOAPIFY_PLACES_URL);
  u.searchParams.set("categories", categories.join(","));
  u.searchParams.set("filter", `circle:${center.lon.toFixed(5)},${center.lat.toFixed(5)},${Math.round(radiusM)}`);
  u.searchParams.set("bias", `proximity:${center.lon.toFixed(5)},${center.lat.toFixed(5)}`);
  u.searchParams.set("limit", String(GEOAPIFY_LIMIT));
  u.searchParams.set("apiKey", key);
  return u.toString();
}

/** Features → the Overpass element shape. Features without OSM identity (other datasources) are dropped. */
export function toOsmElements(body: unknown): RawOsmElement[] {
  const out: RawOsmElement[] = [];
  for (const f of Response.parse(body).features) {
    const raw = f.properties.datasource?.raw;
    if (!raw) continue;
    const type = OSM_TYPES[raw.osm_type as keyof typeof OSM_TYPES];
    const id = Number(raw.osm_id);
    if (!type || !Number.isSafeInteger(id)) continue;
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === "osm_id" || k === "osm_type" || k === "lat" || k === "lon") continue;
      if (typeof v === "string") tags[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") tags[k] = String(v);
    }
    out.push({ type, id, lat: f.properties.lat, lon: f.properties.lon, tags });
  }
  return out;
}

/**
 * One Places request per category group, sequential; elements merged and de-duplicated by OSM identity.
 * Throws on missing key, non-2xx, timeout or an unexpected body (classified by cached()); a failure after an
 * earlier group succeeded carries that group's credits as `units`, so the quota guard still counts them.
 */
export async function fetchPlaces(
  groups: readonly (readonly string[])[],
  center: { lat: number; lon: number },
  radiusM: number,
): Promise<{ elements: RawOsmElement[]; status: number; latencyMs: number; credits: number }> {
  const key = process.env.GEOAPIFY_API_KEY?.trim();
  if (!key) throw new Error("GEOAPIFY_API_KEY missing");
  const byId = new Map<string, RawOsmElement>();
  let latencyMs = 0;
  let credits = 0;
  let status = 200;
  for (const categories of groups) {
    try {
      const r = await fetchJson(placesUrl(categories, center, radiusM, key), { timeoutMs: GEOAPIFY_TIMEOUT_MS });
      const features = Response.parse(r.body).features.length;
      credits += geoapifyCredits(features);
      for (const e of toOsmElements(r.body)) byId.set(`${e.type}/${e.id}`, e);
      latencyMs += r.latencyMs;
      status = r.status;
    } catch (err) {
      if (credits > 0 && err !== null && typeof err === "object") Object.assign(err, { units: credits });
      throw err;
    }
  }
  return { elements: [...byId.values()], status, latencyMs, credits };
}
