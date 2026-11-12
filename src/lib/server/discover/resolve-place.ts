import "server-only";
import type { GeoPlace } from "@/lib/domain/geo";
import { COUNTRY_MISS_MAX_KM, pickAnchorPlace, pickNearestNamed, type RoutePoint } from "@/lib/discover/names";
import { getPlaceById, searchPlacesCached, type SearchLang } from "@/lib/integrations/open-meteo-geocoding";
import type { CachedResult } from "../api-cache";

/** The two geocoding calls a place resolution needs; both go through `cached()` in the defaults (see verify.ts). */
export type GeocodeDeps = {
  geocode: (anchor: string, lang: SearchLang, userId: string) => Promise<CachedResult<GeoPlace[]>>;
  /** A place by id in the user's language (cached 365 days); null on any failure, the first name is used then. */
  placeById: (geoId: number, lang: "de" | "en") => Promise<GeoPlace | null>;
};

export type ResolvedPlace =
  | { status: "ok"; place: GeoPlace; fetchedAt: string; stale: boolean }
  | { status: "not_found" }
  | { status: "failed" };

/** Open-Meteo search languages for countries whose local names are not found in English or German (checked live 2026-11-02). */
const LOCAL_LANGUAGE: Record<string, SearchLang> = { PT: "pt", IT: "it", ES: "es", FR: "fr", TR: "tr" };

/**
 * Place name (+ country) -> a populated place, by code (find-destinations step 1, port-places [P1]). The model or the
 * user writes the name in some spelling and the geocoder only matches names in the requested language, so the search
 * runs with lang=en first and, on a miss, once more in German and in the country's language when it has one. A hit in
 * another language than `lang` is read again by id for the localized name (cached). With a country, only places of
 * that country count; when nothing is found (or no country is known), one last pass takes an exact name match in any
 * country: the one nearest to `opts.near.prev` (the previous stop of the route), else to `opts.near.anchor`; the
 * largest population on a tie or without a reference (a cruise from a German port visits other countries; typed
 * stops have no country, so the destination's country is not assumed). The last pass reads the searches already made, so it costs no extra call. At most 3 searches per name
 * plus one by-id read, all through `cached()`. A failed call is a failure, never "not found".
 */
export async function resolvePlaceName(
  name: string,
  cc: string | null | undefined,
  lang: "de" | "en",
  userId: string,
  deps: GeocodeDeps,
  /** `anyCountry: false` = the country is a hard requirement (destination ideas); default true (stops). */
  opts: { anyCountry?: boolean; near?: { prev?: RoutePoint | null; anchor?: RoutePoint | null } } = {},
): Promise<ResolvedPlace> {
  const anyCountry = opts.anyCountry !== false;
  const country = cc?.trim().toUpperCase() || null;
  const local = country ? LOCAL_LANGUAGE[country] : undefined;
  const langs = ["en", "de", ...(local ? [local] : [])] as SearchLang[];
  const finish = async (hit: GeoPlace, searchLang: SearchLang, res: { fetchedAt: string; stale: boolean }): Promise<ResolvedPlace> => {
    let place = hit;
    if (searchLang !== lang) {
      const localized = await deps.placeById(hit.geoId, lang);
      if (localized) place = { ...hit, name: localized.name, admin1: localized.admin1 ?? hit.admin1 };
    }
    return { status: "ok", place, fetchedAt: res.fetchedAt, stale: res.stale };
  };
  const seen: { lang: SearchLang; res: { data: GeoPlace[]; fetchedAt: string; stale: boolean } }[] = [];
  for (const searchLang of langs) {
    const res = await deps.geocode(name, searchLang, userId);
    if (!res.ok) return { status: "failed" };
    seen.push({ lang: searchLang, res });
    const hit = country ? pickAnchorPlace(res.data, name, country) : null;
    if (hit) return finish(hit, searchLang, res);
    // Without a country the any-country pass needs only en and de.
    if (!country && searchLang === "de") break;
  }
  if (anyCountry) {
    // All candidates of all searches compete (largest population wins), not the first language with an exact match.
    const langOf = new Map<number, (typeof seen)[number]>();
    for (const entry of seen) for (const p of entry.res.data) if (!langOf.has(p.geoId)) langOf.set(p.geoId, entry);
    // A given country without a match there: a namesake elsewhere counts only close to the route (#188).
    const guard = country ? { maxKm: COUNTRY_MISS_MAX_KM, strict: true } : {};
    const hit = pickNearestNamed([...langOf.values()].flatMap((e) => e.res.data.filter((p) => langOf.get(p.geoId) === e)), name, opts.near ?? {}, guard);
    const from = hit && langOf.get(hit.geoId);
    if (hit && from) return finish(hit, from.lang, from.res);
  }
  return { status: "not_found" };
}

/** The cached Open-Meteo geocoding calls (every call reaches `api_calls`). */
export const defaultGeocodeDeps: GeocodeDeps = {
  geocode: (name, lang, userId) => searchPlacesCached(name, lang, { userId: userId || null }),
  placeById: async (geoId, lang) => {
    try {
      return await getPlaceById(geoId, lang);
    } catch {
      return null;
    }
  },
};
