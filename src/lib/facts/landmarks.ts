import { haversineKm, matchesFilter } from "@/lib/facts/places";
import type { RawOsmElement } from "@/lib/integrations/overpass";

/**
 * City landmarks for city tours (issue #172, docs/specs/city-tour.md 3.1 and the "landmarks" implementation notes):
 * OSM elements with a Wikidata id in the categories a visitor walks to (churches, theatres, museums, town halls,
 * castles, main stations, squares, towers, bridges, parks, ...), ranked by prominence = Wikidata sitelink count.
 * Pure: the elements come from Overpass, the sitelink counts from Wikidata (`src/lib/server/tour/landmarks.ts`).
 *
 * Measured 2026-11-12 (Frankfurt, Wien, Passau; numbers in the spec): the `general` interest filters miss
 * non-cathedral churches, theatres, stations, squares and bridges, and ranking by distance puts small memorials
 * before the Dom. Sitelinks order the three cities as a visitor would; cheaper signals (count of `name:*` tags,
 * a wikipedia tag) missed Belvedere and Tiergarten Schönbrunn even in their top 300 and are only the fallback.
 */

/** Landmarks within this distance of the city point (Wien: Schönbrunn 5 km; Passau's GeoNames point is 2.7 km from the Dom). */
export const LANDMARK_RADIUS_KM = 8;
/**
 * Candidates kept per city before the sitelink ranking (stored in the cache; also the sitelinks lookup cap, 40
 * requests). Wien had 1,453 after dedupe; a cap of 1,000 dropped the Wiener Stadthalle (rank 23 by sitelinks).
 */
export const MAX_LANDMARK_CANDIDATES = 2000;
/** Landmarks offered as suggestions / sight candidates. */
export const MAX_LANDMARKS = 60;
/** Same-name elements this close are one place (two nodes of one building, a church and its tower). */
export const LANDMARK_DEDUPE_KM = 0.15;
/** Geoapify search results this close to a matching landmark are that landmark (a station's stops, entrances). */
export const LANDMARK_COLLAPSE_KM = 0.3;

/**
 * Overpass filter lines (each also requires a name, see buildQuery). Every line needs `wikidata`: the prominence
 * signal and the dedupe key. Subway, light rail and tram stations are left out (the "Dom/Römer" and "Alte Oper"
 * U-Bahn stations otherwise shadow the landmarks of the same name). Generic buildings only with `landmark=yes`
 * (Main Tower): office towers and company HQs with a wikidata id were most of the noise in Frankfurt.
 */
export const LANDMARK_FILTERS = [
  `["amenity"~"^(place_of_worship|theatre|arts_centre|concert_hall|townhall|marketplace|planetarium)$"]["wikidata"]`,
  `["building"~"^(cathedral|church|chapel|basilica|synagogue|mosque|temple|palace|castle|train_station)$"]["wikidata"]`,
  `["tourism"~"^(museum|gallery|attraction|viewpoint|zoo|aquarium|theme_park)$"]["wikidata"]`,
  `["historic"~"^(castle|palace|monument|memorial|city_gate|fort|building|church|tower|ruins|manor|monastery|citywalls|bridge)$"]["wikidata"]`,
  `["railway"="station"]["station"!~"^(subway|light_rail|tram|monorail|funicular)$"]["wikidata"]`,
  `["place"="square"]["wikidata"]`,
  `["highway"="pedestrian"]["wikidata"]`,
  `["man_made"~"^(tower|communications_tower|bridge|lighthouse|obelisk)$"]["wikidata"]`,
  `["bridge"]["highway"]["wikidata"]`,
  `["building"]["landmark"="yes"]["wikidata"]`,
  `["leisure"~"^(park|garden)$"]["wikidata"]`,
  `["landuse"="cemetery"]["wikidata"]`,
] as const;

export type LandmarkKind = "sight" | "station" | "street" | "memorial" | "market" | "green" | "building";

/** Weight on the prominence score: stations, streets, memorials, markets, parks and plain buildings rank below sights. */
const KIND_WEIGHT: Record<LandmarkKind, number> = {
  sight: 1,
  station: 0.6,
  street: 0.6,
  memorial: 0.6,
  market: 0.6,
  green: 0.8,
  building: 0.6,
};

export type Landmark = {
  osmType: "node" | "way" | "relation";
  osmId: number;
  name: string;
  names: { de?: string; en?: string };
  /** Other names a user may type: alt_name, short_name, official_name, loc_name, old_name (+ :de/:en). */
  alt: string[];
  /** Icon category (OSM tag value), e.g. "place_of_worship", "theatre", "station". */
  cat: string;
  kind: LandmarkKind;
  lat: number;
  lon: number;
  distanceKm: number;
  wikidata: string;
  wikipedia: boolean;
  /** Number of `name:<lang>` tags: the fallback prominence signal when no sitelink count is known. */
  nameCount: number;
};

/** Case-, accent- and spacing-insensitive form for matching ("Römer" = "romer", "Straße" = "strasse"). */
export const foldName = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss").replace(/\s+/g, " ").trim();

const words = (folded: string) => folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const CORE = /^(place_of_worship|theatre|arts_centre|concert_hall|townhall|planetarium|cathedral|church|chapel|basilica|synagogue|mosque|temple|palace|castle|museum|gallery|zoo|aquarium|theme_park|city_gate|fort|monument|tower|ruins|manor|monastery|citywalls|lighthouse|obelisk|viewpoint)$/;

/** Kind and icon category of a matching element; the most specific tag leads (amenity before tourism=attraction). */
export function classify(tags: Record<string, string>): { kind: LandmarkKind; cat: string } {
  const t = tags;
  if (t.railway === "station" || t.building === "train_station") return { kind: "station", cat: "station" };
  if (t.amenity === "marketplace") return { kind: "market", cat: "marketplace" };
  for (const k of ["amenity", "historic", "building", "tourism", "man_made"] as const) {
    const v = t[k];
    if (v && CORE.test(v)) return { kind: "sight", cat: v };
  }
  if (t.tourism === "attraction") return { kind: "sight", cat: "attraction" };
  if (t.historic === "memorial") return { kind: "memorial", cat: "memorial" };
  if (t.historic === "building" || t.historic === "bridge") return { kind: "sight", cat: t.historic };
  if (t.place === "square") return { kind: "sight", cat: "square" };
  if (t.man_made === "bridge" || t.bridge) return { kind: "sight", cat: "bridge" };
  if (t.highway === "pedestrian") return { kind: "street", cat: "pedestrian" };
  if (t.leisure === "park" || t.leisure === "garden" || t.landuse === "cemetery") {
    return { kind: "green", cat: t.leisure ?? t.landuse };
  }
  return { kind: "building", cat: (t.building && t.building !== "yes" ? t.building : "building").slice(0, 40) };
}

const ALT_KEYS = ["alt_name", "short_name", "official_name", "loc_name", "old_name"] as const;

function altNames(tags: Record<string, string>, name: string): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined) => {
    for (const part of (v ?? "").split(";")) {
      const s = part.trim();
      if (s && s !== name && s.length <= 120) out.add(s);
    }
  };
  add(tags["name:de"]);
  add(tags["name:en"]);
  for (const k of ALT_KEYS) {
    add(tags[k]);
    add(tags[`${k}:de`]);
    add(tags[`${k}:en`]);
  }
  return [...out].slice(0, 12);
}

const TYPE_RANK = { relation: 2, way: 1, node: 0 } as const;

/**
 * Which of two elements with the same wikidata id represents it: a core sight over a park, then more translations.
 * The other element's names stay searchable (its name and aliases join the kept one's `alt`).
 */
function better(a: Landmark, b: Landmark): Landmark {
  const core = (l: Landmark) => (l.kind === "sight" ? 1 : 0);
  const diff = core(b) - core(a) || b.nameCount - a.nameCount || TYPE_RANK[b.osmType] - TYPE_RANK[a.osmType] || a.osmId - b.osmId;
  const [keep, drop] = diff > 0 ? [b, a] : [a, b];
  const alt = new Set(keep.alt);
  for (const n of [drop.name, drop.names.de, drop.names.en, ...drop.alt]) {
    if (n && n !== keep.name) alt.add(n);
  }
  return { ...keep, alt: [...alt].slice(0, 12) };
}

/** Fallback prominence when no sitelink count is known (also the order of the sitelinks lookup). */
export const cheapScore = (l: Pick<Landmark, "nameCount" | "wikipedia" | "distanceKm" | "kind">) =>
  ((l.nameCount + (l.wikipedia ? 3 : 0)) * KIND_WEIGHT[l.kind]) / (1 + l.distanceKm / 5);

/**
 * Elements (Overpass, or any source with OSM tags) → landmark candidates: the code filter (same lines as the query),
 * the exact radius, one element per wikidata id, one per name within 150 m. Order: `cheapScore`, at most
 * MAX_LANDMARK_CANDIDATES.
 */
export function collectLandmarks(
  elements: readonly RawOsmElement[],
  anchor: { lat: number; lon: number },
  maxKm = LANDMARK_RADIUS_KM,
  cap = MAX_LANDMARK_CANDIDATES,
): Landmark[] {
  const byQ = new Map<string, Landmark>();
  for (const e of elements) {
    const name = e.tags.name?.trim();
    const q = e.tags.wikidata?.trim();
    if (!name || !q || !/^Q\d{1,12}$/.test(q)) continue;
    if (!LANDMARK_FILTERS.some((f) => matchesFilter(e.tags, f))) continue;
    const d = haversineKm(anchor, e);
    if (d > maxKm) continue;
    const { kind, cat } = classify(e.tags);
    const names: Landmark["names"] = {};
    if (e.tags["name:de"]) names.de = e.tags["name:de"].slice(0, 120);
    if (e.tags["name:en"]) names.en = e.tags["name:en"].slice(0, 120);
    const l: Landmark = {
      osmType: e.type,
      osmId: e.id,
      name: name.slice(0, 120),
      names,
      alt: altNames(e.tags, name),
      cat,
      kind,
      lat: Number(e.lat.toFixed(6)),
      lon: Number(e.lon.toFixed(6)),
      distanceKm: Math.round(d * 100) / 100,
      wikidata: q,
      wikipedia: Boolean(e.tags.wikipedia),
      nameCount: Object.keys(e.tags).filter((k) => /^name:[a-z]{2,3}(-[A-Za-z]+)?$/.test(k)).length,
    };
    const prev = byQ.get(q);
    byQ.set(q, prev ? better(prev, l) : l);
  }
  const sorted = [...byQ.values()].sort((a, b) => cheapScore(b) - cheapScore(a) || a.distanceKm - b.distanceKm || a.osmId - b.osmId);
  const kept: Landmark[] = [];
  for (const l of sorted) {
    const f = foldName(l.name);
    if (kept.some((k) => foldName(k.name) === f && haversineKm(k, l) <= LANDMARK_DEDUPE_KM)) continue;
    kept.push(l);
    if (kept.length >= cap) break;
  }
  return kept;
}

/** Prominence: (sitelinks + 1 for a wikipedia tag) × kind weight, gently lowered with distance from the city point. */
export function landmarkScore(l: Landmark, sitelinks: Readonly<Record<string, number>> | null): number {
  if (!sitelinks) return cheapScore(l);
  const n = sitelinks[l.wikidata] ?? 0;
  return ((n + (l.wikipedia ? 1 : 0)) * KIND_WEIGHT[l.kind]) / (1 + l.distanceKm / 5);
}

/**
 * Candidates by prominence (sitelinks when known, else the cheap fallback), ties by distance then id. A station that
 * shares a name with a more prominent station within 300 m is one of its levels and is left out ("Hauptbahnhof
 * (tief)", the S-Bahn level 60 m from "Frankfurt (Main) Hauptbahnhof", has its own Wikidata item).
 */
export function rankLandmarks(list: readonly Landmark[], sitelinks: Readonly<Record<string, number>> | null): Landmark[] {
  const scored = list.map((l) => ({ l, s: landmarkScore(l, sitelinks) }));
  scored.sort((a, b) => b.s - a.s || a.l.distanceKm - b.l.distanceKm || a.l.osmId - b.l.osmId);
  const out: Landmark[] = [];
  const stations: number[] = []; // indexes into `out`
  for (const { l } of scored) {
    if (l.kind === "station") {
      const at = stations.find((i) => sameAsLandmark({ name: l.name, lat: l.lat, lon: l.lon }, out[i]));
      if (at !== undefined) {
        // The level's names stay searchable on the station ("tief" still finds the Hauptbahnhof).
        const st = out[at];
        const alt = new Set(st.alt);
        for (const n of [l.name, l.names.de, l.names.en, ...l.alt]) if (n && n !== st.name) alt.add(n);
        out[at] = { ...st, alt: [...alt].slice(0, 12) };
        continue;
      }
      stations.push(out.length);
    }
    out.push(l);
  }
  return out;
}

const variants = (l: Landmark) => [l.name, l.names.de, l.names.en, ...l.alt].filter((s): s is string => Boolean(s)).map(foldName);

/**
 * How well a landmark matches a query, lower is better, null = no match. 0: a name equals the query ("Dom" =
 * loc_name of the Kaiserdom); 1: the query starts a word of a name ("Hauptbahnhof" in "Frankfurt (Main)
 * Hauptbahnhof", "Alte Oper"); 2: anywhere inside a name ("dom" in "Stephansdom").
 */
export function matchTier(l: Landmark, query: string): 0 | 1 | 2 | null {
  const q = foldName(query);
  if (!q) return null;
  let best: 0 | 1 | 2 | null = null;
  for (const v of variants(l)) {
    if (v === q) return 0;
    let tier: 1 | 2 | null = null;
    for (let i = v.indexOf(q); i >= 0; i = v.indexOf(q, i + 1)) {
      tier = i === 0 || !/[\p{L}\p{N}]/u.test(v[i - 1]) ? 1 : 2;
      if (tier === 1) break;
    }
    if (tier !== null && (best === null || tier < best)) best = tier;
  }
  return best;
}

/** Landmarks matching a query: best tier first, then the given (prominence) order. */
export function matchLandmarks(ranked: readonly Landmark[], query: string, limit: number): Landmark[] {
  const hits: { l: Landmark; tier: number; i: number }[] = [];
  ranked.forEach((l, i) => {
    const tier = matchTier(l, query);
    if (tier !== null) hits.push({ l, tier, i });
  });
  hits.sort((a, b) => a.tier - b.tier || a.i - b.i);
  return hits.slice(0, limit).map((h) => h.l);
}

/**
 * A search result (name, point, Geoapify category) is the same place as a matched landmark, within 300 m: the same
 * folded name; or, for a result without a category or with a transport one, one name contained word-wise in the
 * other (the "Hauptbahnhof" B-level stop at "Frankfurt (Main) Hauptbahnhof", the "Dom/Römer" U-Bahn stop at the
 * Römer and at the Dom with loc_name "Dom"). A categorized sight with a longer name ("Haus zum Römer") stays.
 */
export function sameAsLandmark(r: { name: string; lat: number; lon: number; category?: string }, l: Landmark): boolean {
  if (haversineKm(r, l) > LANDMARK_COLLAPSE_KM) return false;
  const rn = foldName(r.name);
  const loose = !r.category || /^(public_transport|railway)(\.|$)/.test(r.category);
  const rw = words(rn);
  for (const v of variants(l)) {
    if (v === rn) return true;
    if (!loose) continue;
    const vw = words(v);
    if (containsRun(rw, vw) || containsRun(vw, rw)) return true;
  }
  return false;
}

/** `inner` appears as a contiguous run of whole words in `outer`. */
function containsRun(outer: string[], inner: string[]): boolean {
  if (!inner.length || inner.length > outer.length) return false;
  for (let i = 0; i + inner.length <= outer.length; i++) {
    if (inner.every((w, j) => outer[i + j] === w)) return true;
  }
  return false;
}
