import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import barcelona from "../integrations/__fixtures__/overpass/general-barcelona-15km.json";
import golf from "../integrations/__fixtures__/overpass/golf-marbella-40km.json";
import bcnSitelinks from "../integrations/__fixtures__/wikidata/sitelinks-barcelona.json";
import { parseElements, type RawOsmElement } from "../integrations/overpass";
import { INTEREST_SOURCES, sourceFor } from "./interest-sources";
import { MAX_CANDIDATES, prominenceBucket, rankCandidates } from "./places";

/**
 * Prominence for trip interest places (issue #172). Fixture recorded 2026-11-12: Overpass around Barcelona, the
 * elements matching the `general` filters (44 within 1.5 km plus the 40 best known), and their Wikidata sitelinks.
 */
const BCN = { lat: 41.389, lon: 2.159 };
const general = sourceFor("general");
if (general.source !== "osm") throw new Error("general has no OSM source");
const els = parseElements(barcelona);
const rank = (sitelinks?: Record<string, number>) =>
  rankCandidates(els, general.filters, BCN, general.exclude, 15, { markOpenAir: true, ...(sitelinks ? { sitelinks } : {}) });

describe("rankCandidates with sitelinks", () => {
  it("Barcelona: Sagrada Família, Camp Nou, the Cathedral and Park Güell survive the cap of 25, near the top", () => {
    const names = rank(bcnSitelinks).map((c) => c.name);
    expect(names).toHaveLength(MAX_CANDIDATES);
    expect(names.slice(0, 2).sort()).toEqual(["Basílica de la Sagrada Família", "Spotify Camp Nou"]);
    expect(names.slice(0, 8)).toContain("Catedral de la Santa Creu i Santa Eulàlia");
    expect(names.slice(0, 10)).toContain("Parc Güell");
  });

  it("without sitelinks the order is the old one (distance among items): the Sagrada Família is cut", () => {
    const names = rank().map((c) => c.name);
    expect(names).not.toContain("Basílica de la Sagrada Família");
    expect(names).not.toContain("Parc Güell");
    // The old order is distance-first among items with wikidata and wikipedia.
    const d = rank().map((c) => c.distanceKm);
    expect(d.slice(0, 5)).toEqual([...d.slice(0, 5)].sort((a, b) => a - b));
  });

  it("distance decides within a prominence bucket; one place per Wikidata item (La Rambla's segments)", () => {
    const list = rank(bcnSitelinks);
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [list[i - 1], list[i]];
      const [ba, bb] = [prominenceBucket(bcnSitelinks[a.wikidata as keyof typeof bcnSitelinks] ?? 0), prominenceBucket(bcnSitelinks[b.wikidata as keyof typeof bcnSitelinks] ?? 0)];
      expect(ba).toBeGreaterThanOrEqual(bb);
    }
    const ids = list.map((c) => c.wikidata);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("buckets: log2 steps", () => {
    expect([0, 1, 2, 3, 4, 7, 8, 44, 55, 89, 109].map(prominenceBucket)).toEqual([0, 1, 1, 2, 2, 3, 3, 5, 5, 6, 6]);
  });

  it("places without a Wikidata item keep their old order behind the items", () => {
    const e = (id: number, name: string, lat: number, tags: Record<string, string>): RawOsmElement => ({ type: "node", id, lat, lon: 2.159, tags: { name, tourism: "museum", ...tags } });
    const out = rankCandidates(
      [e(1, "Nah ohne", 41.3891, {}), e(2, "Fern bekannt", 41.42, { wikidata: "Q1" }), e(3, "Nah bekannt", 41.39, { wikidata: "Q2" }), e(4, "Fern ohne", 41.41, {})],
      [`["tourism"="museum"]`],
      BCN,
      undefined,
      15,
      { sitelinks: { Q1: 100, Q2: 3 } },
    );
    expect(out.map((c) => c.name)).toEqual(["Fern bekannt", "Nah bekannt", "Nah ohne", "Fern ohne"]);
  });

  it("golf (no prominence flag) is ranked exactly as before", () => {
    const src = INTEREST_SOURCES.golf;
    if (src.source !== "osm") throw new Error();
    expect(src.prominence).toBeUndefined();
    const a = rankCandidates(parseElements(golf), src.filters, { lat: 36.51, lon: -4.88 }, src.exclude, 40);
    const b = rankCandidates(parseElements(golf), src.filters, { lat: 36.51, lon: -4.88 }, src.exclude, 40, {});
    expect(b).toEqual(a);
  });

  it("flags: prominence where places usually have a Wikidata item; Overpass first only for sightseeing", () => {
    const flagged = Object.entries(INTEREST_SOURCES).filter(([, s]) => s.source === "osm" && s.prominence).map(([k]) => k).sort();
    expect(flagged).toEqual(["architecture", "city_sightseeing", "family_activities", "hiking", "history", "museums", "nature_wildlife"]);
    const first = Object.entries(INTEREST_SOURCES).filter(([, s]) => s.source === "osm" && s.overpassFirst).map(([k]) => k);
    expect(first).toEqual(["city_sightseeing"]);
  });
});
