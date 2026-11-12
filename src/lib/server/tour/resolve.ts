import "server-only";
import type { Locale } from "@/lib/domain/profile";
import {
  legKey,
  TourInput,
  type TourDraftParsed,
  type TourPoint,
  type TourPointDraft,
  type TourResult,
} from "@/lib/domain/tour";
import { getPlaceById } from "@/lib/integrations/open-meteo-geocoding";
import type { CacheCtx } from "../api-cache";
import { placeDetails } from "../facts/place-search";
import { verifyPointRef } from "./point-ref";

/**
 * Server-side point resolution (city tour spec 3.1). A draft point becomes a `TourPoint` only from data the server
 * produced itself, in this order:
 * 1. a valid signed `ref` for that key (`point-ref.ts`): a Geoapify OSM result is resolved once to its `osm:` key and
 *    category through place details (1 credit, cached 90 days); the signed values otherwise;
 * 2. a point already stored in this tour's input, or a sight of its stored result (both written after an earlier
 *    resolution; `result` is server-written only);
 * 3. `geo:<GeoNames id>`: looked up by id on Open-Meteo (cached 365 days), like a trip destination.
 * Anything else is `unknown_point`. Coordinates, names, sources and categories of the request are never used.
 */
export type KnownPoints = Map<string, TourPoint>;

export const GEO_KEY = /^geo:(\d{1,10})$/;

/** Points of a stored tour (input and result sights) that may be sent back without a reference. */
export function knownPoints(input: TourInput | null, result: TourResult | null): KnownPoints {
  const out: KnownPoints = new Map();
  const add = (p: TourPoint | undefined) => {
    if (p) out.set(p.key, { ...p, dwellMin: undefined });
  };
  if (input) {
    add(input.city);
    input.places.forEach(add);
    add(input.start);
    if (typeof input.end === "object") add(input.end);
  }
  for (const s of result?.sights ?? []) {
    if (!out.has(s.key)) out.set(s.key, { key: s.key, name: s.name, lat: s.lat, lon: s.lon, source: "osm", cat: s.cat.slice(0, 40) });
  }
  return out;
}

type One = { ok: true; point: TourPoint } | { ok: false; error: "unknown_point" | "failed"; key: string };

const withoutUndefined = (p: TourPoint): TourPoint =>
  Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as TourPoint;

async function resolveOne(d: TourPointDraft, known: KnownPoints, locale: Locale, ctx: CacheCtx): Promise<One> {
  const dwell = (p: TourPoint): One => ({ ok: true, point: withoutUndefined({ ...p, dwellMin: d.dwellMin }) });
  if (d.ref) {
    const ref = verifyPointRef(d.ref, d.key);
    if (!ref) return { ok: false, error: "unknown_point", key: d.key };
    if (ref.g?.osm) {
      const det = await placeDetails(ref.g.id, locale, ctx);
      if (det?.osmKey) {
        return dwell({ key: det.osmKey, name: det.name, lat: det.lat, lon: det.lon, source: "osm", cat: det.cat });
      }
      // Details unavailable: the Geoapify result stays a `gfy:` point with its signed (verified) coordinates.
    }
    return dwell(ref.p);
  }
  const stored = known.get(d.key);
  if (stored) return dwell(stored);
  const geo = GEO_KEY.exec(d.key);
  if (geo) {
    try {
      const place = await getPlaceById(Number(geo[1]), locale);
      if (!place) return { ok: false, error: "unknown_point", key: d.key };
      return dwell({ key: d.key, name: place.name.slice(0, 120), lat: place.lat, lon: place.lon, source: "geonames" });
    } catch {
      return { ok: false, error: "failed", key: d.key };
    }
  }
  return { ok: false, error: "unknown_point", key: d.key };
}

export type Resolved =
  | { ok: true; input: TourInput }
  | { ok: false; error: "unknown_point"; keys: string[] }
  | { ok: false; error: "failed" }
  | { ok: false; error: "invalid"; issues: { path: string; message: string }[] };

/**
 * Resolves every point of a draft and returns the validated `TourInput`. Leg overrides are re-keyed when a point's
 * key changed during resolution (`gfy:` → `osm:`); overrides naming no point of the tour are dropped.
 */
export async function resolveDraft(
  draft: TourDraftParsed,
  known: KnownPoints,
  locale: Locale,
  ctx: CacheCtx,
): Promise<Resolved> {
  const end = typeof draft.end === "object" ? draft.end : undefined;
  const all = [draft.city, ...draft.places, draft.start, end];
  const res = await Promise.all(all.map((d) => (d ? resolveOne(d, known, locale, ctx) : Promise.resolve(null))));
  const bad = res.filter((r): r is Extract<One, { ok: false }> => r !== null && !r.ok);
  if (bad.some((r) => r.error === "failed")) return { ok: false, error: "failed" };
  if (bad.length) return { ok: false, error: "unknown_point", keys: [...new Set(bad.map((r) => r.key))] };
  const pts = res.map((r) => (r && r.ok ? r.point : undefined));
  const rename = new Map<string, string>();
  all.forEach((d, i) => d && pts[i] && rename.set(d.key, pts[i]!.key));

  let legOverrides: TourInput["legOverrides"];
  if (draft.legOverrides) {
    legOverrides = {};
    for (const [k, v] of Object.entries(draft.legOverrides)) {
      const sep = k.indexOf(">");
      const from = rename.get(k.slice(0, sep));
      const to = rename.get(k.slice(sep + 1));
      if (sep > 0 && from && to) legOverrides[legKey(from, to)] = v;
    }
  }
  const [city, ...rest] = pts;
  const places = rest.slice(0, draft.places.length) as TourPoint[];
  const start = rest[draft.places.length];
  const endPoint = rest[draft.places.length + 1];
  const candidate = {
    ...draft,
    city,
    places,
    start,
    end: draft.end === "start" ? ("start" as const) : endPoint,
    legOverrides,
  };
  const parsed = TourInput.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid",
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    };
  }
  return { ok: true, input: parsed.data };
}
