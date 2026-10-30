import type { PlaceCandidate } from "@/lib/domain/facts";
import type { InterestExclude } from "@/lib/facts/interest-sources";
import type { RawOsmElement } from "@/lib/integrations/overpass";

export const MAX_CANDIDATES = 25;
export const DEDUPE_KM = 0.2;

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss").replace(/\s+/g, " ").trim();

type Clause = { key: string; op: "=" | "~"; value: string };
/** Parses `["tourism"~"^(a|b)$"]["wikidata"]` into clauses; existence-only clauses have no op. */
function parseFilter(filter: string): Clause[] {
  const out: Clause[] = [];
  for (const m of filter.matchAll(/\["([^"]+)"(?:(=|~)"([^"]*)")?\]/g)) {
    if (m[2]) out.push({ key: m[1], op: m[2] as "=" | "~", value: m[3] });
  }
  return out;
}

/**
 * Full Overpass semantics of one filter line (`["k"="v"]`, `["k"~"re"]`, `["k"!~"re"]`, `["k"]`), for results
 * that did not come from an Overpass query with that filter (Geoapify). `!~` also matches when the key is absent,
 * like Overpass. Every filter line of an interest also requires a name (buildQuery adds `["name"]`).
 */
export function matchesFilter(tags: Record<string, string>, filter: string): boolean {
  if (!tags.name) return false;
  for (const m of filter.matchAll(/\["([^"]+)"(?:(=|~|!~)"([^"]*)")?\]/g)) {
    const [, key, op, value] = m;
    const v = tags[key];
    if (!op) {
      if (v === undefined) return false;
    } else if (op === "=") {
      if (v !== value) return false;
    } else if (op === "~") {
      if (v === undefined || !new RegExp(value).test(v)) return false;
    } else if (v !== undefined && new RegExp(value).test(v)) {
      return false;
    }
  }
  return true;
}

/** Category of the first filter's value clause that the element matches, as `key=value`. */
export function matchCategory(tags: Record<string, string>, filters: readonly string[]): string | null {
  for (const f of filters) {
    const clauses = parseFilter(f);
    const main = clauses[0];
    const v = main && tags[main.key];
    if (v === undefined) continue;
    if (main.op === "=" ? v === main.value : new RegExp(main.value).test(v)) return `${main.key}=${v}`;
  }
  return null;
}

/**
 * Drop unnamed, rank by (wikidata, wikipedia, distance), dedupe by name + 200 m, keep top 25.
 * Pure: `anchor` is the destination point the distance is measured from. `maxKm` enforces the exact radius
 * (the Overpass query only uses a bounding box, whose corners reach 1.41x further).
 */
export function rankCandidates(
  elements: readonly RawOsmElement[],
  filters: readonly string[],
  anchor: { lat: number; lon: number },
  exclude?: InterestExclude,
  maxKm?: number,
): PlaceCandidate[] {
  const all: PlaceCandidate[] = [];
  const nameRe = exclude?.nameRegex ? new RegExp(exclude.nameRegex, "i") : null;
  const named = elements.filter((e) => {
    const n = e.tags.name?.trim();
    return n && !(nameRe && nameRe.test(n));
  });
  const hasAreas = named.some((e) => e.type !== "node");
  for (const e of named) {
    if (exclude?.dropNodesIfAreas && hasAreas && e.type === "node") continue;
    if (maxKm !== undefined && haversineKm(anchor, e) > maxKm) continue;
    const name = e.tags.name!.trim();
    const names: PlaceCandidate["names"] = {};
    if (e.tags["name:de"]) names.de = e.tags["name:de"];
    if (e.tags["name:en"]) names.en = e.tags["name:en"];
    const c: PlaceCandidate = {
      osmType: e.type,
      osmId: e.id,
      name,
      names,
      category: matchCategory(e.tags, filters) ?? "unknown",
      lat: e.lat,
      lon: e.lon,
      distanceKm: Math.round(haversineKm(anchor, e) * 10) / 10,
      osmUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`,
    };
    if (e.tags.wikidata) c.wikidata = e.tags.wikidata;
    if (e.tags.wikipedia) c.wikipedia = e.tags.wikipedia;
    const website = e.tags.website ?? e.tags["contact:website"];
    if (website && /^https?:\/\//i.test(website)) c.website = website;
    all.push(c);
  }
  const score = (c: PlaceCandidate) => (c.wikidata ? 0 : 2) + (c.wikipedia ? 0 : 1);
  all.sort((a, b) => score(a) - score(b) || a.distanceKm - b.distanceKm || a.name.localeCompare(b.name));
  const kept: PlaceCandidate[] = [];
  for (const c of all) {
    const key = fold(c.name);
    if (kept.some((k) => fold(k.name) === key && haversineKm(k, c) <= DEDUPE_KM)) continue;
    kept.push(c);
    if (kept.length >= MAX_CANDIDATES) break;
  }
  return kept;
}
