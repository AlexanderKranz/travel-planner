import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { geoapifyCredits, placesUrl, toOsmElements } from "./geoapify";
import { matchesFilter } from "@/lib/facts/places";

// Shape recorded from a live call (2026-10-30, Passau castles), trimmed.
const body = {
  features: [
    { properties: { lat: 48.5063, lon: 13.4505, datasource: { raw: { osm_id: 166630652, osm_type: "w", name: "Schloss Neuburg", historic: "castle", wikidata: "Q1763652", website: "https://landkreisgalerie.de/schloss-neuburg/", postcode: 4783 } } } },
    { properties: { lat: 48.526, lon: 13.4432, datasource: { raw: { osm_id: 3782554852, osm_type: "n", name: "Neufels", historic: "castle" } } } },
    { properties: { lat: 1, lon: 2, datasource: { raw: { name: "no osm identity" } } } },
  ],
};

describe("Geoapify client", () => {
  it("maps features to OSM elements with string tags; drops features without OSM identity", () => {
    const els = toOsmElements(body);
    expect(els).toHaveLength(2);
    expect(els[0]).toMatchObject({ type: "way", id: 166630652, lat: 48.5063, lon: 13.4505 });
    expect(els[0].tags).toMatchObject({ name: "Schloss Neuburg", historic: "castle", wikidata: "Q1763652", postcode: "4783" });
    expect(els[0].tags.osm_id).toBeUndefined();
    expect(els[1].type).toBe("node");
  });
  it("builds a circle filter around the centre (lon,lat order) and bills per 20 places", () => {
    const u = new URL(placesUrl(["sport.golf_course"], { lat: 36.51, lon: -4.8825 }, 40000, "k"));
    expect(u.searchParams.get("filter")).toBe("circle:-4.88250,36.51000,40000");
    expect(u.searchParams.get("categories")).toBe("sport.golf_course");
    expect([geoapifyCredits(0), geoapifyCredits(20), geoapifyCredits(21), geoapifyCredits(100)]).toEqual([1, 1, 2, 5]);
  });
});

describe("matchesFilter (Overpass semantics in code)", () => {
  const sight = `["historic"~"^(castle|monument|city_gate|fort)$"]["wikidata"]`;
  it("value, regex and existence clauses; a name is required", () => {
    expect(matchesFilter({ name: "Veste Oberhaus", historic: "castle", wikidata: "Q1" }, sight)).toBe(true);
    expect(matchesFilter({ name: "Neufels", historic: "castle" }, sight)).toBe(false); // no wikidata
    expect(matchesFilter({ name: "Karyatide", tourism: "artwork", wikidata: "Q2" }, sight)).toBe(false);
    expect(matchesFilter({ historic: "castle", wikidata: "Q1" }, sight)).toBe(false); // unnamed
  });
  it("negated regex matches when the key is absent or the value differs", () => {
    const golf = `["leisure"="golf_course"]["golf"!~"^(driving_range|practice)$"]`;
    expect(matchesFilter({ name: "Las Brisas", leisure: "golf_course" }, golf)).toBe(true);
    expect(matchesFilter({ name: "Range", leisure: "golf_course", golf: "driving_range" }, golf)).toBe(false);
  });
});
