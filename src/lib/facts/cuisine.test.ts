import { describe, expect, it } from "vitest";
import type { RawOsmElement } from "@/lib/integrations/overpass";
import {
  Cuisine, FAST_FOOD_CUISINES, LOCAL_CUISINE, MAX_CAFES, MAX_RESTAURANTS, isKidsTagged, localCuisinesFor, parseCuisines, selectCafes,
  selectRestaurants, toCafes, toRestaurants, type Restaurant,
} from "./cuisine";

let n = 0;
const r = (name: string, cuisine: string | undefined, extra: Partial<Restaurant> = {}): Restaurant => ({
  osmType: "node",
  osmId: ++n,
  name,
  cuisines: parseCuisines(cuisine),
  lat: 0,
  lon: 0,
  distanceKm: 1,
  hasOpeningHours: false,
  kidsTagged: false,
  osmUrl: "u",
  ...extra,
});

describe("parseCuisines", () => {
  it("splits ; lists, normalizes and de-duplicates", () => {
    expect(parseCuisines("Italian; pizza;italian")).toEqual(["italian", "pizza"]);
    expect(parseCuisines("steak house")).toEqual(["steak_house"]);
    expect(parseCuisines(undefined)).toEqual([]);
    expect(parseCuisines("")).toEqual([]);
  });
});

describe("cuisine tables", () => {
  it("enum has about 40 values and covers the fast-food set", () => {
    expect(Cuisine.options.length).toBeGreaterThanOrEqual(40);
    for (const c of FAST_FOOD_CUISINES) expect(Cuisine.options as readonly string[]).toContain(c);
  });
  it("covers the required countries; others fall back to regional", () => {
    for (const cc of ["DE", "AT", "CH", "ES", "IT", "FR", "PT", "NL", "GB", "GR", "HR"]) expect(LOCAL_CUISINE[cc], cc).toBeDefined();
    expect(localCuisinesFor("de")).toContain("german");
    expect(localCuisinesFor("JP")).toEqual(["regional"]);
    expect(localCuisinesFor(null)).toEqual(["regional"]);
  });
});

describe("selectRestaurants", () => {
  const pool = [
    r("Zum Löwen", "german"),
    r("Ratskeller", "regional"),
    r("Frankenstube", "franconian"),
    r("Pizzeria Roma", "pizza"),
    r("Trattoria", "italian"),
    r("Bella Napoli", "italian;pizza"),
    r("Deutsch-Pizza", "german;pizza"),
    r("Burger King", "burger"),
    r("Mystery Grill", undefined),
    r("Sushi Bar", "asian;sushi"),
  ];
  const names = (s: ReturnType<typeof selectRestaurants>) => s.restaurants.map((x) => x.name);

  it("local cuisine in Germany never returns pizza", () => {
    const s = selectRestaurants(pool, { local: true }, "DE");
    expect(names(s).sort()).toEqual(["Frankenstube", "Ratskeller", "Zum Löwen"]);
    for (const x of s.restaurants) expect(x.cuisines.some((c) => FAST_FOOD_CUISINES.has(c))).toBe(false);
    expect(s.tooFew).toBe(false);
  });
  it("pizza stays local in Italy", () => {
    expect(names(selectRestaurants(pool, { local: true }, "IT"))).toContain("Pizzeria Roma");
  });
  it("a country without a table uses regional only", () => {
    expect(names(selectRestaurants(pool, { local: true }, "JP"))).toEqual(["Ratskeller"]);
  });
  it("no wish: fast food is dropped, untagged restaurants are kept", () => {
    const s = selectRestaurants(pool, null, "DE");
    expect(names(s)).toContain("Mystery Grill");
    expect(names(s)).not.toContain("Pizzeria Roma");
    expect(names(s)).not.toContain("Burger King");
    expect(names(s)).not.toContain("Bella Napoli");
  });
  it("include keeps matches, including fast-food values it names; untagged are dropped", () => {
    const s = selectRestaurants(pool, { include: ["pizza"] }, "DE");
    expect(names(s).sort()).toEqual(["Bella Napoli", "Deutsch-Pizza", "Pizzeria Roma"]);
  });
  it("include: italian keeps italian;pizza; plain local still drops german;pizza", () => {
    const inc = names(selectRestaurants(pool, { include: ["italian"] }, "DE"));
    expect(inc).toContain("Bella Napoli");
    expect(inc).toContain("Trattoria");
    expect(inc).not.toContain("Pizzeria Roma");
    expect(names(selectRestaurants(pool, { local: true }, "DE"))).not.toContain("Deutsch-Pizza");
    expect(names(selectRestaurants(pool, null, "DE"))).not.toContain("Bella Napoli");
  });
  it("local + include is a union", () => {
    const s = selectRestaurants(pool, { local: true, include: ["sushi"] }, "DE");
    expect(names(s)).toContain("Sushi Bar");
    expect(names(s)).toContain("Ratskeller");
  });
  it("exclude always drops", () => {
    const s = selectRestaurants(pool, { local: true, exclude: ["franconian"] }, "DE");
    expect(names(s)).not.toContain("Frankenstube");
  });
  it("marks tooFew instead of padding", () => {
    const s = selectRestaurants(pool, { include: ["sushi"] }, "DE");
    expect(names(s)).toEqual(["Sushi Bar"]);
    expect(s.tooFew).toBe(true);
    expect(selectRestaurants(pool, { include: ["thai"] }, "DE")).toMatchObject({ restaurants: [], matched: 0, tooFew: true });
  });
  it("ranks by completeness, then distance; caps at 12", () => {
    const near = r("Near", "german", { distanceKm: 0.2 });
    const complete = r("Complete", "german", { distanceKm: 2, website: "https://x.test", hasOpeningHours: true, wikidata: "Q1" });
    const far = r("Far", "german", { distanceKm: 2 });
    expect(names(selectRestaurants([far, near, complete], null, "DE"))).toEqual(["Complete", "Near", "Far"]);
    const many = Array.from({ length: 30 }, (_, i) => r(`R${i}`, "german", { distanceKm: i / 10 }));
    const s = selectRestaurants(many, null, "DE");
    expect(s.restaurants).toHaveLength(MAX_RESTAURANTS);
    expect(s.matched).toBe(30);
    expect(s.restaurants[0].name).toBe("R0");
  });
});

describe("kids tags (addendum A4)", () => {
  it("kids_area, highchair (yes or a count) and changing_table set kidsTagged; no/absent do not", () => {
    expect(isKidsTagged({ kids_area: "yes" })).toBe(true);
    expect(isKidsTagged({ highchair: "yes" })).toBe(true);
    expect(isKidsTagged({ highchair: "2" })).toBe(true);
    expect(isKidsTagged({ changing_table: "yes" })).toBe(true);
    expect(isKidsTagged({ kids_area: "no", highchair: "no", changing_table: "no" })).toBe(false);
    expect(isKidsTagged({ highchair: "0" })).toBe(false);
    expect(isKidsTagged({ amenity: "restaurant" })).toBe(false);
  });
  it("toRestaurants and toCafes parse the flag and only take their own amenity", () => {
    const els: RawOsmElement[] = [
      { type: "node" as const, id: 1, lat: 0, lon: 0, tags: { name: "A", amenity: "restaurant", highchair: "yes" } },
      { type: "node" as const, id: 2, lat: 0, lon: 0, tags: { name: "B", amenity: "restaurant" } },
      { type: "node" as const, id: 3, lat: 0, lon: 0, tags: { name: "C", amenity: "cafe", kids_area: "yes", cuisine: "coffee_shop;cake" } },
      { type: "node" as const, id: 4, lat: 0, lon: 0, tags: { amenity: "cafe" } },
    ];
    const anchor = { lat: 0, lon: 0 };
    expect(toRestaurants(els, anchor).map((x) => [x.name, x.kidsTagged])).toEqual([["A", true], ["B", false]]);
    expect(toCafes(els, anchor).map((x) => [x.name, x.kidsTagged, x.cuisines])).toEqual([["C", true, ["coffee_shop", "cake"]]]);
  });
  const pool = [
    r("Plain Near", "german", { distanceKm: 0.1, website: "https://x.test", hasOpeningHours: true, wikidata: "Q1" }),
    r("Kids Far", "german", { distanceKm: 2, kidsTagged: true }),
    r("Plain Mid", "german", { distanceKm: 1 }),
  ];
  const names = (s: ReturnType<typeof selectRestaurants>) => s.restaurants.map((x) => x.name);
  it("without the flag the ranking ignores the tags", () => {
    expect(names(selectRestaurants(pool, null, "DE"))).toEqual(["Plain Near", "Plain Mid", "Kids Far"]);
    expect(names(selectRestaurants(pool, { kids: false }, "DE"))).toEqual(["Plain Near", "Plain Mid", "Kids Far"]);
  });
  it("with kids, tagged places rank first and nothing is filtered out", () => {
    const s = selectRestaurants(pool, { kids: true }, "DE");
    expect(names(s)).toEqual(["Kids Far", "Plain Near", "Plain Mid"]);
    expect(s.matched).toBe(3);
  });
  it("kids composes with a cuisine wish (filter first, then tagged first)", () => {
    const mixed = [...pool, r("Pizzeria", "pizza", { kidsTagged: true })];
    expect(names(selectRestaurants(mixed, { local: true, kids: true }, "DE"))).toEqual(["Kids Far", "Plain Near", "Plain Mid"]);
  });
});

describe("selectCafes", () => {
  const cafes = Array.from({ length: 10 }, (_, i) => r(`Cafe ${i}`, "coffee_shop", { distanceKm: i / 10 }));
  it("caps at 6, nearest first among equals", () => {
    const s = selectCafes(cafes);
    expect(s.cafes.map((c) => c.name)).toEqual(["Cafe 0", "Cafe 1", "Cafe 2", "Cafe 3", "Cafe 4", "Cafe 5"]);
    expect(s.cafes).toHaveLength(MAX_CAFES);
    expect(s.matched).toBe(10);
  });
  it("completeness beats distance; kids first only when asked", () => {
    const rich = r("Rich", "coffee_shop", { distanceKm: 2, website: "https://x.test", hasOpeningHours: true });
    const kid = r("Kid", undefined, { distanceKm: 3, kidsTagged: true });
    expect(selectCafes([...cafes, kid, rich]).cafes[0].name).toBe("Rich");
    expect(selectCafes([...cafes, kid, rich]).cafes.map((c) => c.name)).not.toContain("Kid");
    expect(selectCafes([...cafes, rich, kid], { kids: true }).cafes.slice(0, 2).map((c) => c.name)).toEqual(["Kid", "Rich"]);
  });
});
