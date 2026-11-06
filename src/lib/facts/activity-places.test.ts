import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseElements } from "../integrations/overpass";
import { MAX_PER_GROUP, MAX_PER_TYPE, activityPlacesForGroup } from "./activity-places";
import { selectRestaurants, toRestaurants } from "./cuisine";

const fixture = (f: string) =>
  parseElements(JSON.parse(readFileSync(new URL(`../integrations/__fixtures__/overpass/${f}`, import.meta.url), "utf8")));
const WUERZBURG = { lat: 49.7913, lon: 9.9534 };

describe("indoor group (recorded Overpass response, Wuerzburg, 15 km)", () => {
  const els = fixture("indoor-wuerzburg-15km.json");
  const places = activityPlacesForGroup("indoor", els, WUERZBURG);
  it("tags every place with its catalogue type and finds the escape room", () => {
    const eg = places.filter((p) => p.types.includes("escape_game"));
    expect(eg).toHaveLength(1);
    expect(eg[0].category).toBe("leisure=escape_game");
    expect(new Set(places.flatMap((p) => p.types))).toEqual(new Set(["escape_game", "bowling", "cinema", "theatre", "climbing_hall"]));
  });
  it("limits per type and per group, keeps each element once", () => {
    for (const t of new Set(places.flatMap((p) => p.types))) expect(places.filter((p) => p.types.includes(t)).length).toBeLessThanOrEqual(MAX_PER_TYPE);
    expect(places.length).toBeLessThanOrEqual(MAX_PER_GROUP);
    expect(new Set(places.map((p) => `${p.osmType}/${p.osmId}`)).size).toBe(places.length);
  });
  it("a dense type does not crowd the others out (round-robin)", () => {
    expect(new Set(places.slice(0, 5).flatMap((p) => p.types)).size).toBe(5);
    expect(places.every((p) => p.group === "indoor")).toBe(true);
  });
  it("a group query only yields that group's types", () => {
    expect(activityPlacesForGroup("going_out", els, WUERZBURG)).toEqual([]);
  });
});

describe("outdoor group (recorded Overpass response, Wuerzburg, 25 km)", () => {
  const els = fixture("outdoor-wuerzburg-25km.json");
  it("finds water and minigolf places, tagged with their type", () => {
    const places = activityPlacesForGroup("outdoor", els, WUERZBURG);
    const types = new Set(places.flatMap((p) => p.types));
    expect(types.has("minigolf")).toBe(true);
    expect(types.has("canoe") || types.has("rowing") || types.has("boat_rental")).toBe(true);
    expect(places.length).toBeLessThanOrEqual(MAX_PER_GROUP);
  });
  const el = (id: number, sport: string, extra: Record<string, string> = {}) => ({
    type: "node" as const, id, lat: 49.79, lon: 9.95, tags: { name: `Place ${id}`, sport, ...extra },
  });
  const typesIn = (group: "indoor" | "outdoor", ...els: ReturnType<typeof el>[]) => activityPlacesForGroup(group, els, WUERZBURG).map((p) => p.types);

  it("sport is a semicolon list: multi-value tags match (spaces tolerated), look-alike tokens do not", () => {
    const hall = (sport: string) => typesIn("indoor", el(1, sport, { leisure: "sports_centre" }));
    expect(hall("climbing;fitness")).toEqual([["climbing_hall"]]);
    expect(hall("fitness; climbing")).toEqual([["climbing_hall"]]);
    expect(hall("climbing_adventure")).toEqual([]);
    const out = (sport: string) => typesIn("outdoor", el(2, sport));
    expect(out("canoe;kayak")).toEqual([["canoe"]]);
    expect(out("swimming; rowing")).toEqual([["rowing"]]);
    expect(out("karting;go_kart")).toEqual([["karting"]]);
    expect(out("footgolf")).toEqual([["footgolf"]]);
    expect(out("canoe_polo")).toEqual([]);
  });
  it("a place counts for every type it matches (sport=rowing;canoe is a rowing and a canoe place)", () => {
    expect(typesIn("outdoor", el(3, "rowing;canoe"))).toEqual([["rowing", "canoe"]]);
    const places = activityPlacesForGroup("outdoor", [el(3, "rowing; canoe")], WUERZBURG);
    expect(places).toHaveLength(1); // one place in the group list, not two
    expect(places[0].types).toContain("canoe");
  });
  it("climbing_hall: sports_centre or indoor=yes; outdoor climbing: climbing=crag only", () => {
    expect(typesIn("indoor", el(4, "climbing", { indoor: "yes" }))).toEqual([["climbing_hall"]]);
    expect(typesIn("indoor", el(5, "climbing", { leisure: "sports_centre" }))).toEqual([["climbing_hall"]]);
    expect(typesIn("indoor", el(6, "climbing"))).toEqual([]);
    expect(typesIn("outdoor", el(7, "climbing", { climbing: "crag" }))).toEqual([["climbing"]]);
    expect(typesIn("outdoor", el(8, "climbing"))).toEqual([]);
  });
  it("an outdoor type tagged indoor=yes counts as indoor", () => {
    const e = { type: "node" as const, id: 1, lat: 49.79, lon: 9.95, tags: { name: "Indoor Minigolf", leisure: "miniature_golf", indoor: "yes" } };
    const [p] = activityPlacesForGroup("outdoor", [e], WUERZBURG);
    expect(p).toMatchObject({ types: ["minigolf"], group: "indoor" });
  });
});

describe("restaurants (recorded Overpass response, Wuerzburg, 2.5 km)", () => {
  const all = toRestaurants(fixture("restaurants-wuerzburg-2.5km.json"), WUERZBURG, 2.5);
  it("normalizes named restaurants within the radius", () => {
    expect(all.length).toBeGreaterThan(100);
    expect(all.every((x) => x.distanceKm <= 2.5 && x.name)).toBe(true);
    expect(all.some((x) => x.cuisines.length > 1)).toBe(true); // e.g. asian;sushi
  });
  it("local cuisine in Germany returns only local places, never pizza", () => {
    const s = selectRestaurants(all, { local: true }, "DE");
    expect(s.restaurants.length).toBeGreaterThanOrEqual(3);
    expect(s.tooFew).toBe(false);
    for (const x of s.restaurants) {
      expect(x.cuisines.some((c) => ["german", "regional", "franconian", "bavarian", "swabian"].includes(c))).toBe(true);
      expect(x.cuisines).not.toContain("pizza");
    }
  });
  it("without a wish no pizza or burger place is returned", () => {
    const s = selectRestaurants(all, null, "DE");
    for (const x of s.restaurants) expect(x.cuisines.some((c) => ["pizza", "burger"].includes(c))).toBe(false);
  });
});
