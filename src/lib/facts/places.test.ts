import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import golf from "../integrations/__fixtures__/overpass/golf-marbella-40km.json";
import passau from "../integrations/__fixtures__/overpass/general-passau-15km.json";
import { parseElements, type RawOsmElement } from "../integrations/overpass";
import { INTEREST_SOURCES } from "./interest-sources";
import { MAX_CANDIDATES, haversineKm, matchCategory, rankCandidates } from "./places";

const el = (id: number, name: string | undefined, lat: number, lon: number, tags: Record<string, string> = {}): RawOsmElement => ({
  type: "node", id, lat, lon, tags: { ...(name ? { name } : {}), ...tags },
});
const F = [`["leisure"="golf_course"]`];

describe("places", () => {
  it("haversine: Passau - Wien is ~ 220 km", () => {
    const d = haversineKm({ lat: 48.5665, lon: 13.43122 }, { lat: 48.20849, lon: 16.37208 });
    expect(d).toBeGreaterThan(190);
    expect(d).toBeLessThan(225);
  });

  it("drops unnamed, ranks wikidata > wikipedia > distance", () => {
    const anchor = { lat: 0, lon: 0 };
    const r = rankCandidates(
      [
        el(1, undefined, 0, 0.01),
        el(2, "Near", 0, 0.01, { leisure: "golf_course" }),
        el(3, "Far wd", 0, 0.5, { leisure: "golf_course", wikidata: "Q1" }),
        el(4, "Mid wp", 0, 0.2, { leisure: "golf_course", wikipedia: "de:Mid" }),
      ],
      F,
      anchor,
    );
    expect(r.map((c) => c.name)).toEqual(["Far wd", "Mid wp", "Near"]);
    expect(r[0].wikidata).toBe("Q1");
    expect(r[0].osmUrl).toBe("https://www.openstreetmap.org/node/3");
    expect(r[2].category).toBe("leisure=golf_course");
  });

  it("dedupes same name within 200 m but keeps same name far away", () => {
    const r = rankCandidates(
      [el(1, "Azata Golf", 36.5, -4.9), el(2, "azata golf", 36.5005, -4.9), el(3, "Azata Golf", 36.7, -4.9)],
      F,
      { lat: 36.5, lon: -4.9 },
    );
    expect(r.map((c) => c.osmId)).toEqual([1, 3]);
  });

  it("keeps at most 25 and only http(s) websites", () => {
    const many = Array.from({ length: 40 }, (_, i) => el(i, `P${i}`, 0, i * 0.01, i === 0 ? { website: "javascript:alert(1)" } : {}));
    const r = rankCandidates(many, F, { lat: 0, lon: 0 });
    expect(r).toHaveLength(MAX_CANDIDATES);
    expect(r[0].website).toBeUndefined();
  });

  it("matchCategory handles regex filters", () => {
    expect(matchCategory({ historic: "castle" }, [`["historic"~"^(castle|ruins)$"]["wikidata"]`])).toBe("historic=castle");
    expect(matchCategory({ historic: "tomb" }, [`["historic"~"^(castle|ruins)$"]`])).toBeNull();
  });

  it("works on the recorded Marbella golf fixture", () => {
    const src = INTEREST_SOURCES.golf;
    if (src.source !== "osm") throw new Error();
    const r = rankCandidates(parseElements(golf), src.filters, { lat: 36.515, lon: -4.886 });
    expect(r).toHaveLength(MAX_CANDIDATES);
    expect(r.every((c) => c.category === "leisure=golf_course")).toBe(true);
  });

  it("works on the recorded Passau fixture (Dom St. Stephan with wikidata ranks first group)", () => {
    const src = INTEREST_SOURCES.city_sightseeing;
    if (src.source !== "osm") throw new Error();
    const r = rankCandidates(parseElements(passau), src.filters, { lat: 48.5665, lon: 13.431 });
    const dom = r.find((c) => c.name === "Dom St. Stephan");
    expect(dom).toBeDefined();
    expect(dom?.distanceKm).toBeLessThan(3.5);
    expect(r.slice(0, 3).every((c) => c.wikidata)).toBe(true);
  });
});
