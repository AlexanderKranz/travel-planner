import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import family from "../integrations/__fixtures__/overpass/family-passau-25km.json";
import { parseElements, type RawOsmElement } from "../integrations/overpass";
import { interestPlaceGroup } from "@/lib/plan/input";
import { INTEREST_SOURCES } from "./interest-sources";
import { rankCandidates } from "./places";

const ANCHOR = { lat: 48.5665, lon: 13.43122 };
const el = (id: number, tags: Record<string, string>): RawOsmElement => ({ type: "way", id, lat: 48.57, lon: 13.43, tags });
const F = [`["leisure"="water_park"]`, `["tourism"="zoo"]`];

describe("open-air interest places (issue #142)", () => {
  it("rankCandidates marks open-air baths only when asked", () => {
    const els = [
      el(1, { leisure: "water_park", name: "Passauer Erlebnisbad (PEB)", note: "Freibad" }),
      el(2, { leisure: "water_park", name: "Europa Therme" }),
      el(3, { tourism: "zoo", name: "Freibad-Zoo" }),
    ];
    const byId = (cs: ReturnType<typeof rankCandidates>) => Object.fromEntries(cs.map((c) => [c.osmId, c.openAir]));
    expect(byId(rankCandidates(els, F, ANCHOR, undefined, undefined, { markOpenAir: true }))).toEqual({ 1: true, 2: undefined, 3: undefined });
    expect(byId(rankCandidates(els, F, ANCHOR))).toEqual({ 1: undefined, 2: undefined, 3: undefined });
  });

  it("interestPlaceGroup: baths only; the flag, else the name (candidates cached before the flag)", () => {
    expect(interestPlaceGroup({ category: "leisure=water_park", name: "Passauer Erlebnisbad (PEB)", openAir: true })).toBe("outdoor");
    expect(interestPlaceGroup({ category: "leisure=water_park", name: "Passauer Erlebnisbad (PEB)" })).toBe("indoor");
    expect(interestPlaceGroup({ category: "leisure=water_park", name: "Freibad Vilshofen" })).toBe("outdoor");
    expect(interestPlaceGroup({ category: "tourism=zoo", name: "Tierpark" })).toBeUndefined();
  });

  it("recorded Passau family lookup: the PEB (OSM note Freibad) is outdoor, the thermal baths are not", () => {
    const src = INTEREST_SOURCES.family_activities;
    if (src.source !== "osm") throw new Error("no osm source");
    const cs = rankCandidates(parseElements(family), src.filters, ANCHOR, src.exclude, 25, { markOpenAir: true });
    const peb = cs.find((c) => c.name === "Passauer Erlebnisbad (PEB)");
    expect(peb && interestPlaceGroup(peb)).toBe("outdoor");
    // Every candidate named Freibad is outdoor; zoos and parks stay unclassified.
    for (const c of cs) {
      if (/freibad/i.test(c.name)) expect(interestPlaceGroup(c)).toBe("outdoor");
      if (c.category !== "leisure=water_park") expect(interestPlaceGroup(c)).toBeUndefined();
    }
  });
});
