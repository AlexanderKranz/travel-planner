import "server-only";
import type { GeoPlace } from "@/lib/domain/geo";
import { COUNTRY_MISS_MAX_KM, NEAR_ROUTE_MAX_KM, featureRank, foldName, pickAnchorPlace, pickNearestNamed, type RoutePoint } from "@/lib/discover/names";
import { cleanPlaceName, stripLeadingArticle } from "@/lib/discover/place-name";
import { haversineKm } from "@/lib/facts/places";
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

/**
 * Open-Meteo search languages for countries whose local names are not found in English or German (checked live
 * 2026-11-02). Open-Meteo has no Maltese: MT searches in Italian, which finds "La Valletta" as the Maltese capital
 * (PPLC) where English and German return only two Italian villages (checked live 2026-11-12).
 */
const LOCAL_LANGUAGE: Record<string, SearchLang> = { PT: "pt", IT: "it", ES: "es", FR: "fr", TR: "tr", MT: "it" };
/** The language of the one retry without a leading article ("Valletta" is the Maltese capital in en and de). */
const BARE_LANG: SearchLang = "en";

/** Searches a cold name can cost: en, de, the country's language, and one retry without a leading article. */
export const MAX_SEARCHES_PER_NAME = 4;

type Seen = { lang: SearchLang; res: { data: GeoPlace[]; fetchedAt: string; stale: boolean } };

/**
 * Place name (+ country) -> a populated place, by code (find-destinations step 1, port-places [P1]). The model or the
 * user writes the name in some spelling and the geocoder only matches names in the requested language, so the search
 * runs with lang=en first and, on a miss, once more in German and in the country's language when it has one. A hit in
 * another language than `lang` is read again by id for the localized name (cached). With a country, only places of
 * that country count; when nothing is found (or no country is known), one last pass takes an exact name match in any
 * country: the highest feature rank (PPLC > PPLA* > PPL), then the one nearest to `opts.near.prev` (the previous stop
 * of the route), else to `opts.near.anchor`; the largest population on a tie or without a reference (a cruise from a
 * German port visits other countries; typed stops have no country, so the destination's country is not assumed). The
 * last pass reads the searches already made, so it costs no extra call. A failed call is a failure, never "not found".
 *
 * Name cleaning (2026-11-12): the search uses `cleanPlaceName` ("Messina (Sizilien)" -> "Messina", "Name, Region" ->
 * "Name"); the caller keeps the name as typed. A name with a leading article ("La Valletta") gets one more search
 * without it (in English) when the country has no match, or, without a country, when the any-country pick is missing
 * or only a plain village (PPL). Its candidates count in the given country, else only within the route radius of a
 * reference point (500 km with a country, 2,500 km without), never as a guess without one.
 * Bounded: at most MAX_SEARCHES_PER_NAME (4) searches plus one by-id read per cold name, all through `cached()`.
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
  const langs = [...new Set<SearchLang>(["en", "de", ...(local ? [local] : [])])];
  const search = cleanPlaceName(name);
  const finish = async (hit: GeoPlace, searchLang: SearchLang, res: { fetchedAt: string; stale: boolean }): Promise<ResolvedPlace> => {
    let place = hit;
    if (searchLang !== lang) {
      const localized = await deps.placeById(hit.geoId, lang);
      if (localized) place = { ...hit, name: localized.name, admin1: localized.admin1 ?? hit.admin1 };
    }
    return { status: "ok", place, fetchedAt: res.fetchedAt, stale: res.stale };
  };
  const seen: Seen[] = [];
  for (const searchLang of langs) {
    const res = await deps.geocode(search, searchLang, userId);
    if (!res.ok) return { status: "failed" };
    seen.push({ lang: searchLang, res });
    const hit = country ? pickAnchorPlace(res.data, search, country) : null;
    if (hit) return finish(hit, searchLang, res);
    // Without a country the any-country pass needs only en and de.
    if (!country && searchLang === "de") break;
  }
  // Without its article a name counts only near the route, from any search: "Palmas" (BR) is no answer to "Las
  // Palmas", and without a reference point it is never a guess.
  const refs = [opts.near?.prev, opts.near?.anchor].filter((r): r is RoutePoint => !!r);
  const bareMaxKm = country ? COUNTRY_MISS_MAX_KM : NEAR_ROUTE_MAX_KM;
  const nearRoute = (p: GeoPlace) => refs.some((r) => haversineKm(r, p) <= bareMaxKm);
  // All candidates of all searches compete, not the first language with an exact match. Each place counts once, in
  // the first search that returned it under a wanted name ("Genoa" in en and "Genua" in de are one geoId).
  const anyPick = (entries: Seen[], bareName: string | null) => {
    const full = foldName(search);
    const bareKey = bareName ? foldName(bareName) : null;
    const wanted = (p: GeoPlace) => {
      const n = foldName(p.name);
      return n === full || (n === bareKey && nearRoute(p));
    };
    const langOf = new Map<number, Seen>();
    for (const entry of entries) for (const p of entry.res.data) if (!langOf.has(p.geoId) && wanted(p)) langOf.set(p.geoId, entry);
    // A given country without a match there: a namesake elsewhere counts only close to the route (#188).
    const guard = country ? { maxKm: COUNTRY_MISS_MAX_KM, strict: true } : {};
    const pool = [...langOf.values()].flatMap((e) => e.res.data.filter((p) => langOf.get(p.geoId) === e && wanted(p)));
    const hit = pickNearestNamed(pool, bareName ? [search, bareName] : [search], opts.near ?? {}, guard);
    const from = hit && langOf.get(hit.geoId);
    return hit && from ? { hit, from } : null;
  };
  let pick = anyCountry ? anyPick(seen, null) : null;

  const bare = stripLeadingArticle(search);
  const retry = bare !== null && (country !== null || !pick || featureRank(pick.hit.featureCode) < 2);
  if (bare !== null && retry) {
    const res = await deps.geocode(bare, BARE_LANG, userId);
    if (!res.ok) return pick ? finish(pick.hit, pick.from.lang, pick.from.res) : { status: "failed" };
    const hit = country ? pickAnchorPlace(res.data, bare, country) : null;
    if (hit) return finish(hit, BARE_LANG, res);
    if (anyCountry) pick = anyPick([...seen, { lang: BARE_LANG, res }], bare) ?? pick;
  }
  return pick ? finish(pick.hit, pick.from.lang, pick.from.res) : { status: "not_found" };
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
