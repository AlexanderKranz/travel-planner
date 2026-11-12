import type { GeoPlace } from "@/lib/domain";
import { cleanPlaceName, pickDestinationPlace, stripLeadingArticle } from "@/lib/discover/place-name";
import { geocode, placeLabel } from "@/lib/geocode-client";
import type { DestinationDraft } from "./trip-draft";

/** The geocoder answer the destination needs (`geocode` in `src/lib/geocode-client.ts`). */
export type PortGeocode = (q: string, lang: string) => Promise<{ results: GeoPlace[]; unavailable: boolean; rateLimited: boolean }>;

const browserGeocode: PortGeocode = (q, lang) => geocode(q, lang, new AbortController().signal);

/** Shortest query `/api/geocode` accepts. */
const MIN_QUERY = 2;

/**
 * The first port of an upload -> the trip destination, the way the destination picker sets it (#193 follow-up): the
 * cleaned name ("Messina (Sizilien)" -> "Messina") is searched with `/api/geocode` in the UI language; an exact
 * populated place wins (`pickDestinationPlace`: only the port's country when it has one, then feature rank and
 * population) and becomes a picked city. With a country and no match, one more search without a leading article
 * ("La Valletta" -> "Valletta"). Without a country there is no such retry: "Palmas" (BR) is no answer to "Las Palmas".
 * At most 2 searches. Nothing found, or the geocoder unavailable: the free-text destination as before. Never throws.
 */
export async function destinationForPort(
  port: { name: string; cc?: string },
  locale: string,
  countryCodes: readonly string[],
  search: PortGeocode = browserGeocode,
): Promise<DestinationDraft> {
  const freeText: DestinationDraft = {
    mode: "freetext",
    name: port.name,
    countryCode: port.cc && countryCodes.includes(port.cc) ? port.cc : "",
  };
  const q = cleanPlaceName(port.name);
  if (q.length < MIN_QUERY) return freeText;
  try {
    const first = await search(q, locale);
    let pick = pickDestinationPlace(first.results, [q], port.cc);
    const bare = port.cc ? stripLeadingArticle(q) : null;
    if (!pick && bare && bare.length >= MIN_QUERY && !first.rateLimited) {
      const second = await search(bare, locale);
      pick = pickDestinationPlace([...first.results, ...second.results], [q, bare], port.cc);
    }
    if (!pick) return freeText;
    return {
      mode: "geo",
      geoKind: "city",
      geoId: pick.geoId,
      placeName: pick.name,
      placeLabel: placeLabel(pick, locale),
      name: pick.name,
      radiusKm: null,
    };
  } catch {
    return freeText;
  }
}
