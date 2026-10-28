import type { SourceId } from "@/lib/domain";

/** Presentation data per source (label/licence text live in messages under `sources.items.<id>`). */
export const SOURCE_META: Record<
  SourceId,
  { homepage: string | null; licenseUrl: string | null }
> = {
  open_meteo: { homepage: "https://open-meteo.com/", licenseUrl: "https://creativecommons.org/licenses/by/4.0/" },
  geonames: { homepage: "https://www.geonames.org/", licenseUrl: "https://creativecommons.org/licenses/by/4.0/" },
  osm: { homepage: "https://www.openstreetmap.org/copyright", licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/" },
  wikivoyage: { homepage: "https://www.wikivoyage.org/", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/" },
  rest_countries: { homepage: "https://restcountries.com/", licenseUrl: "https://www.mozilla.org/MPL/2.0/" },
  suncalc: { homepage: null, licenseUrl: null },
};

export const SOURCE_IDS = Object.keys(SOURCE_META) as SourceId[];

/** Only http(s) URLs from external data become links. */
export function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}
