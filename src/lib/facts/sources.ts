import type { SourceId } from "@/lib/domain/facts";

export type SourceInfo = {
  id: SourceId;
  homepage: string | null;
  license: string;
  licenseUrl: string | null;
  /** next-intl key under `sources.` for the label shown next to a fact. */
  labelKey: string;
};

export const SOURCES: Record<SourceId, SourceInfo> = {
  open_meteo: { id: "open_meteo", homepage: "https://open-meteo.com/", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", labelKey: "open_meteo" },
  geonames: { id: "geonames", homepage: "https://www.geonames.org/", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", labelKey: "geonames" },
  osm: { id: "osm", homepage: "https://www.openstreetmap.org/copyright", license: "ODbL 1.0", licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/", labelKey: "osm" },
  wikivoyage: { id: "wikivoyage", homepage: "https://www.wikivoyage.org/", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", labelKey: "wikivoyage" },
  wikipedia: { id: "wikipedia", homepage: "https://www.wikipedia.org/", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", labelKey: "wikipedia" },
  wikimedia: { id: "wikimedia", homepage: "https://commons.wikimedia.org/", license: "CC0, public domain, CC BY or CC BY-SA (per picture)", licenseUrl: null, labelKey: "wikimedia" },
  rest_countries: { id: "rest_countries", homepage: "https://github.com/mledoze/countries", license: "ODbL 1.0", licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/", labelKey: "rest_countries" },
  aerodatabox: { id: "aerodatabox", homepage: "https://aerodatabox.com", license: "RapidAPI Basic plan (non-commercial, attribution required)", licenseUrl: null, labelKey: "aerodatabox" },
  openrouteservice: { id: "openrouteservice", homepage: "https://openrouteservice.org/", license: "© openrouteservice.org, data © OpenStreetMap contributors (ODbL 1.0)", licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/", labelKey: "openrouteservice" },
  suncalc: { id: "suncalc", homepage: null, license: "n/a", licenseUrl: null, labelKey: "suncalc" },
};

export const SOURCE_IDS = Object.keys(SOURCES) as SourceId[];

/** Only http(s) URLs from external data become links. Client-safe. */
export function safeUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** "de:Passauer Dom" -> https://de.wikipedia.org/wiki/Passauer_Dom (null if malformed). Client-safe. */
export function wikipediaUrl(tag: string): string | null {
  const m = /^([a-z]{2,3}(?:-[a-z]+)?):(.+)$/.exec(tag);
  if (!m) return null;
  return `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, "_"))}`;
}

/** Best link for a place: its own website, then Wikipedia, then the OSM object (http(s) only). */
export function placeHref(p: { website?: string; wikipedia?: string; osmUrl: string }): string | null {
  return safeUrl(p.website) ?? (p.wikipedia ? wikipediaUrl(p.wikipedia) : null) ?? safeUrl(p.osmUrl);
}
