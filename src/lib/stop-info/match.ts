/**
 * Matching a tour stop to Wikidata / Wikipedia (docs/specs/city-tour-stop-info.md section 2). Pure.
 *
 * Only `osm:` points can get a card: `geo:` (a town as start or end, [Q3]) and `gfy:` (an address) never do.
 * A `wikidata` tag wins over a `wikipedia` tag; the latter is read as `<lang>:<title>` and used only for de/en.
 */
import { safeUrl } from "@/lib/facts/sources";
import { QID } from "@/lib/domain/stop-info";

export type OsmRef = { type: "node" | "way" | "relation"; id: number };

const OSM_KEY = /^osm:([nwr])(\d{1,15})$/;
const TYPE = { n: "node", w: "way", r: "relation" } as const;

/** The OSM element of a point key, or null for keys that never get a card. */
export function osmRefOf(key: string): OsmRef | null {
  const m = OSM_KEY.exec(key);
  return m ? { type: TYPE[m[1] as keyof typeof TYPE], id: Number(m[2]) } : null;
}

export const osmRefKey = (r: OsmRef): string => `osm:${r.type[0]}${r.id}`;

/** A Wikidata id when it is well-formed, else null. */
export function cleanQid(v: string | undefined | null): string | null {
  const s = v?.trim() ?? "";
  return QID.test(s) ? s : null;
}

/** `de:Passauer Dom` → { lang: "de", title: "Passauer Dom" }; other languages or no prefix → null. */
export function parseWikipediaTag(v: string | undefined | null): { lang: "de" | "en"; title: string } | null {
  const m = /^(de|en):(.+)$/.exec(v?.trim() ?? "");
  if (!m) return null;
  let title = m[2];
  try {
    title = decodeURIComponent(title);
  } catch {
    // keep as written
  }
  title = title.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return title && title.length <= 200 ? { lang: m[1] as "de" | "en", title } : null;
}

/** A website value as an absolute http(s) URL (bare domains get https://), at most 300 characters, else null. */
export function cleanWebsite(v: string | undefined | null): string | null {
  let s = v?.trim() ?? "";
  if (!s || s.length > 300 || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  const url = safeUrl(s);
  if (!url || url.length > 300) return null;
  try {
    const u = new URL(url);
    if (u.username || u.password || !u.hostname.includes(".")) return null;
  } catch {
    return null;
  }
  return url;
}

/** Opening hours as tagged (raw, "laut OpenStreetMap"); a value over 255 characters is left out, never cut. */
export function cleanOpeningHours(v: string | undefined | null): string | null {
  const s = v?.trim() ?? "";
  return s && s.length <= 255 ? s : null;
}

export type OsmFacts = {
  qid: string | null;
  wikipedia: { lang: "de" | "en"; title: string } | null;
  website: string | null;
  openingHours: string | null;
};

/** The tags the spec keeps, cleaned. */
export function osmFacts(tags: Record<string, string>): OsmFacts {
  return {
    qid: cleanQid(tags.wikidata),
    wikipedia: parseWikipediaTag(tags.wikipedia),
    website: cleanWebsite(tags.website) ?? cleanWebsite(tags["contact:website"]),
    openingHours: cleanOpeningHours(tags.opening_hours),
  };
}

/** Year wording by the stop's OSM category (spec 3): buildings "built", stations/museums "opened", else "since". */
export function yearKind(cat: string | undefined): "built" | "opened" | "since" {
  if (!cat) return "since";
  if (/^(place_of_worship|church|cathedral|castle|tower|bridge|monument|memorial|fort|palace|city_gate|ruins)$/.test(cat)) return "built";
  if (/^(station|museum|gallery|theatre|zoo|aquarium)$/.test(cat)) return "opened";
  return "since";
}
