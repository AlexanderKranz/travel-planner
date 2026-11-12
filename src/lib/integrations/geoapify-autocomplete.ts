/**
 * Geoapify Address Autocomplete and Place Details (city tour place search, spec docs/specs/city-tour.md 3.1 and
 * section 14). Docs checked 2026-11-12: https://apidocs.geoapify.com/docs/geocoding/address-autocomplete/ and
 * https://apidocs.geoapify.com/docs/place-details/. 1 credit per request each (of the free plan's 3,000/day); no
 * quota headers. Same key as Places (`GEOAPIFY_API_KEY`, read only here, never logged; HttpError carries no URL).
 *
 * Spike 2026-11-12 (recorded in __fixtures__/geoapify-autocomplete/): autocomplete results carry no OSM id (only
 * `datasource.sourcename`), and the same OSM node came back twice. Place details has `datasource.raw` with
 * `osm_type`/`osm_id`, `wikidata`, `opening_hours`. The OSM identity hidden in `place_id` is undocumented and not used.
 * Data: © OpenStreetMap contributors (ODbL), Who's On First (CC0), GeoNames (CC BY 4.0); powered by Geoapify.
 */
import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { fetchJson } from "./http";

export const GEOAPIFY_AUTOCOMPLETE_URL = "https://api.geoapify.com/v1/geocode/autocomplete";
export const GEOAPIFY_DETAILS_URL = "https://api.geoapify.com/v2/place-details";
export const AUTOCOMPLETE_TIMEOUT_MS = 5_000;
export const DETAILS_TIMEOUT_MS = 8_000;
/** Spec 3.1: search inside 20 km of the city, at most 8 results, at least 3 characters. */
export const AUTOCOMPLETE_RADIUS_M = 20_000;
export const AUTOCOMPLETE_LIMIT = 8;
export const AUTOCOMPLETE_MIN_CHARS = 3;
export const AUTOCOMPLETE_MAX_CHARS = 100;
/** Two results with the same name this close are one place (the spike's duplicate "Stephansdom Krypta" was 0.1 m apart). */
export const DEDUPE_M = 30;

/** Normalized query text: NFC, trimmed, single spaces, lowercase (the cache key uses the same). */
export const normalizeQuery = (q: string) => q.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

/** `place_id` is a long hex string (100-200 characters in the spike). */
export const PlaceId = z.string().regex(/^[0-9a-f]{8,512}$/);

/**
 * Tour point key of a search result. `gfy:<place_id>` would be up to ~170 characters, above the 40 of the tour
 * point key (spec 3.1), so the key holds a hash of it: `gfy:` + 32 hex = 36 characters, stable per place_id.
 */
export function gfyKey(placeId: string): string {
  return `gfy:${createHash("sha256").update(placeId).digest("hex").slice(0, 32)}`;
}

export type PlaceSuggestion = {
  /** `gfy:<hash of place_id>`; resolved to `osm:` through place details when the user adds an OSM result. */
  key: string;
  placeId: string;
  name: string;
  lat: number;
  lon: number;
  /** Geoapify datasource: "openstreetmap" results can be resolved to an OSM key, the others stay `gfy:`. */
  datasource: string;
  /** Second address line for the list ("Stephansplatz 3, 1010 Wien, Österreich"). */
  address?: string;
  /** Geoapify category, e.g. "tourism.attraction" (only some results have one). */
  category?: string;
  /** Metres from the search centre (sent because of `bias=proximity`). */
  distanceM?: number;
};

const Result = z.object({
  place_id: PlaceId,
  name: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  category: z.string().optional(),
  distance: z.number().optional(),
  datasource: z.object({ sourcename: z.string() }).optional(),
});
const AutocompleteResponse = z.object({ results: z.array(z.unknown()) });

/** Centre rounded to 2 decimals (~1 km): the request uses the same cell as the cache key, so cached answers match. */
export const cell = (p: { lat: number; lon: number }) => ({ lat: Number(p.lat.toFixed(2)), lon: Number(p.lon.toFixed(2)) });

export function autocompleteUrl(q: string, center: { lat: number; lon: number }, lang: string, key: string): string {
  const c = cell(center);
  const u = new URL(GEOAPIFY_AUTOCOMPLETE_URL);
  u.searchParams.set("text", normalizeQuery(q));
  u.searchParams.set("filter", `circle:${c.lon},${c.lat},${AUTOCOMPLETE_RADIUS_M}`);
  u.searchParams.set("bias", `proximity:${c.lon},${c.lat}`);
  u.searchParams.set("lang", lang);
  u.searchParams.set("limit", String(AUTOCOMPLETE_LIMIT));
  u.searchParams.set("format", "json");
  u.searchParams.set("apiKey", key);
  return u.toString();
}

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(x));
}

const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Results → suggestions, in Geoapify's order. A result that does not match the schema or has no name is skipped
 * (never repaired); the same name within DEDUPE_M of an earlier result is a duplicate and dropped. Results that all
 * fail the schema mean the response shape changed: that throws, so an empty list is not cached for 30 days.
 */
export function parseAutocomplete(body: unknown): PlaceSuggestion[] {
  const out: PlaceSuggestion[] = [];
  const results = AutocompleteResponse.parse(body).results;
  let usable = 0;
  for (const raw of results) {
    const r = Result.safeParse(raw);
    if (!r.success) continue;
    const name = (r.data.name ?? r.data.address_line1)?.trim().slice(0, 120);
    if (!name) continue;
    usable++;
    const s: PlaceSuggestion = {
      key: gfyKey(r.data.place_id),
      placeId: r.data.place_id,
      name,
      lat: r.data.lat,
      lon: r.data.lon,
      datasource: r.data.datasource?.sourcename ?? "unknown",
    };
    if (r.data.address_line2) s.address = r.data.address_line2.slice(0, 200);
    if (r.data.category) s.category = r.data.category.slice(0, 60);
    if (r.data.distance !== undefined && Number.isFinite(r.data.distance)) s.distanceM = Math.round(r.data.distance);
    if (out.some((o) => fold(o.name) === fold(s.name) && distanceM(o, s) <= DEDUPE_M)) continue;
    out.push(s);
  }
  if (results.length > 0 && usable === 0) throw new z.ZodError([]);
  return out;
}

/** Geoapify bills the request once it answered, also when the body then fails to parse: carry the credit to cached(). */
function charged<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err !== null && typeof err === "object") Object.assign(err, { units: 1 });
    throw err;
  }
}

/** One autocomplete request (1 credit). Throws on missing key, invalid input, non-2xx, timeout or a bad body. */
export async function fetchAutocomplete(input: {
  q: string;
  lat: number;
  lon: number;
  lang: string;
}): Promise<{ suggestions: PlaceSuggestion[]; status: number; latencyMs: number }> {
  const key = process.env.GEOAPIFY_API_KEY?.trim();
  if (!key) throw new Error("GEOAPIFY_API_KEY missing");
  const q = normalizeQuery(input.q);
  if (q.length < AUTOCOMPLETE_MIN_CHARS || q.length > AUTOCOMPLETE_MAX_CHARS) throw new RangeError("query length");
  if (!/^[a-z]{2}$/.test(input.lang)) throw new RangeError("lang");
  const r = await fetchJson(autocompleteUrl(q, input, input.lang, key), { timeoutMs: AUTOCOMPLETE_TIMEOUT_MS });
  return { suggestions: charged(() => parseAutocomplete(r.body)), status: r.status, latencyMs: r.latencyMs };
}

export type PlaceDetails = {
  /** `osm:n123`, `osm:w456`, `osm:r789`, or null when the place is not from OpenStreetMap. */
  osmKey: string | null;
  name: string;
  lat: number;
  lon: number;
  /** OSM category value for the icon, e.g. "place_of_worship". */
  cat?: string;
  /** Raw OSM `opening_hours` tag, shown with its source, never interpreted (spec [T11]). */
  openingHours?: string;
  wikidata?: string;
};

const DetailsResponse = z.object({
  features: z
    .array(
      z.object({
        properties: z.object({
          name: z.string().optional(),
          lat: z.number().min(-90).max(90),
          lon: z.number().min(-180).max(180),
          datasource: z
            .object({ sourcename: z.string().optional(), raw: z.record(z.string(), z.unknown()).optional() })
            .optional(),
        }),
      }),
    )
    .min(1),
});

/** OSM keys whose value names the kind of place, most specific first (tourism=attraction is too generic to lead). */
const CAT_KEYS = ["amenity", "historic", "tourism", "leisure", "natural", "man_made", "shop", "building"] as const;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function placeDetailsUrl(placeId: string, lang: string, key: string): string {
  const u = new URL(GEOAPIFY_DETAILS_URL);
  u.searchParams.set("id", placeId);
  u.searchParams.set("lang", lang);
  u.searchParams.set("apiKey", key);
  return u.toString();
}

/** The `details` feature → OSM identity and the few tags a tour point needs. Throws on a body without a feature. */
export function parsePlaceDetails(body: unknown, lang: string): PlaceDetails {
  const p = DetailsResponse.parse(body).features[0].properties;
  const raw = p.datasource?.sourcename === "openstreetmap" ? (p.datasource.raw ?? {}) : {};
  const type = raw.osm_type;
  const id = Number(raw.osm_id);
  const osmKey = (type === "n" || type === "w" || type === "r") && Number.isSafeInteger(id) && id > 0 ? `osm:${type}${id}` : null;
  const name = (str(raw[`name:${lang}`]) ?? str(p.name) ?? str(raw.name))?.slice(0, 120);
  if (!name) throw new z.ZodError([]);
  const out: PlaceDetails = { osmKey, name, lat: p.lat, lon: p.lon };
  const catKey = CAT_KEYS.find((k) => str(raw[k]) && raw[k] !== "yes");
  if (catKey) out.cat = str(raw[catKey])!.slice(0, 40);
  const oh = str(raw.opening_hours);
  // Never cut: a truncated rule can drop an exception ("…; PH off") and turn into a wrong fact. OSM caps tags at 255.
  if (oh && oh.length <= 255) out.openingHours = oh;
  const wd = str(raw.wikidata);
  if (wd && /^Q\d+$/.test(wd)) out.wikidata = wd;
  return out;
}

/** One place details request (1 credit). Throws on missing key, a bad id, non-2xx, timeout or a bad body. */
export async function fetchPlaceDetails(
  placeId: string,
  lang: string,
): Promise<{ details: PlaceDetails; status: number; latencyMs: number }> {
  const key = process.env.GEOAPIFY_API_KEY?.trim();
  if (!key) throw new Error("GEOAPIFY_API_KEY missing");
  PlaceId.parse(placeId);
  if (!/^[a-z]{2}$/.test(lang)) throw new RangeError("lang");
  const r = await fetchJson(placeDetailsUrl(placeId, lang, key), { timeoutMs: DETAILS_TIMEOUT_MS });
  return { details: charged(() => parsePlaceDetails(r.body, lang)), status: r.status, latencyMs: r.latencyMs };
}
