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
  rest_countries: { id: "rest_countries", homepage: "https://github.com/mledoze/countries", license: "ODbL 1.0", licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/", labelKey: "rest_countries" },
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
