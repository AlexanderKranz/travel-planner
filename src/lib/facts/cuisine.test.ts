import { describe, expect, it } from "vitest";
import { Cuisine, FAST_FOOD_CUISINES, LOCAL_CUISINE, MAX_RESTAURANTS, localCuisinesFor, parseCuisines, selectRestaurants, type Restaurant } from "./cuisine";

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
