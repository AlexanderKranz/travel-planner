import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ActivityGroupLookup, RestaurantLookup, TripFacts } from "@/lib/domain/facts";
import type { ActivityWishTag, PlanDay } from "@/lib/domain/plan";
import { activityPlacesForGroup } from "@/lib/facts/activity-places";
import { ACTIVITY_SOURCES } from "@/lib/facts/activity-types";
import { FAST_FOOD_CUISINES, LOCAL_CUISINE, MAX_RESTAURANTS, toRestaurants } from "@/lib/facts/cuisine";
import { parseElements } from "@/lib/integrations/overpass";
import {
  MAX_PER_EXTRA_TYPE,
  MAX_PER_NAMED_TYPE,
  activitiesInput,
  maxId,
  restaurantsInput,
  selectWishPlaces,
  wishPlacePicks,
} from "./activities-input";
import { assembleDay, emptyIssues, referencedPlaces } from "./assemble";
import { drivePicks } from "./drive-picks";
import { activityPlacesPending, allPlacesPending } from "./places-pending";

vi.mock("server-only", () => ({}));

const fixture = (f: string) =>
  parseElements(JSON.parse(readFileSync(new URL(`../integrations/__fixtures__/overpass/${f}`, import.meta.url), "utf8")));
const WUE = { lat: 49.791, lon: 9.953 };
const T = "2026-11-06T00:00:00.000Z";
const indoor: ActivityGroupLookup = { group: "indoor", status: "ok", places: activityPlacesForGroup("indoor", fixture("indoor-wuerzburg-15km.json"), WUE), fetchedAt: T };
const outdoor: ActivityGroupLookup = { group: "outdoor", status: "ok", places: activityPlacesForGroup("outdoor", fixture("outdoor-wuerzburg-25km.json"), WUE), fetchedAt: T };
const restaurants: RestaurantLookup = { status: "ok", restaurants: toRestaurants(fixture("restaurants-wuerzburg-2.5km.json"), WUE, 2.5), radiusKm: 2.5, fetchedAt: T };

const escapeIdea: ActivityWishTag = { types: ["escape_game"], open: true, label: "Friday evening event" };
const water: ActivityWishTag = { types: ["rowing", "footgolf"], open: true, label: "Saturday main event" };

describe("selectWishPlaces (recorded Würzburg lookups)", () => {
  const sel = selectWishPlaces([indoor, outdoor], [escapeIdea, water]);

  it("an open wish lists its named type and the other types of its group, each with a status", () => {
    const types = sel[0].types;
    expect(types.map((t) => t.t)).toContain("bowling");
    expect(types.every((t) => ACTIVITY_SOURCES[t.t].group === "indoor")).toBe(true);
    const eg = types.find((t) => t.t === "escape_game")!;
    expect(eg.s).toBe("ok");
    expect(eg.places.length).toBeGreaterThan(0);
    expect(eg.places.length).toBeLessThanOrEqual(MAX_PER_NAMED_TYPE);
    for (const t of types.filter((x) => x.t !== "escape_game")) expect(t.places.length).toBeLessThanOrEqual(MAX_PER_EXTRA_TYPE);
  });

  it("footgolf without a match is `empty`, a type of a group that was not looked up is `skipped`, a failed group `error`", () => {
    expect(sel[1].types.find((t) => t.t === "footgolf")?.s).toBe("empty");
    expect(selectWishPlaces([indoor], [water])[0].types.every((t) => t.s === "skipped")).toBe(true);
    const failed: ActivityGroupLookup = { group: "outdoor", status: "error", places: [] };
    expect(selectWishPlaces([failed], [water])[0].types.every((t) => t.s === "error")).toBe(true);
  });

  it("drops wishes with nothing to expand", () => {
    expect(selectWishPlaces([indoor], [{ types: [], open: false }])).toEqual([]);
  });
});

describe("activitiesInput / restaurantsInput", () => {
  const sel = selectWishPlaces([indoor, outdoor], [escapeIdea, water]);

  it("assigns a ids once per place, keeps p ids of known places, carries the effective group and drive minutes", () => {
    const first = sel[0].types[0].places[0].p;
    const known = new Map([[`${first.osmType}/${first.osmId}`, "p7"]]);
    const second = sel[0].types.flatMap((t) => t.places)[1].p;
    const drive = { byKey: { [`${second.osmType}/${second.osmId}`]: { min: 12, km: 8.1 } }, fetchedAt: T };
    const out = activitiesInput(sel, { lang: "de", drive, known, startN: 0 });
    const ids = out.block!.places.map((p) => p.id);
    expect(ids[0]).toBe("a1");
    expect(new Set(ids).size).toBe(ids.length);
    expect(out.block!.wishes[0]).toMatchObject({ w: "Friday evening event", open: true });
    expect(out.block!.wishes[0].types[0].ids?.[0]).toBe("p7");
    expect(out.index.a1.place.drive).toMatchObject({ min: 12, source: "openrouteservice" });
    expect(out.block!.places[0].min).toBe(12);
    for (const p of out.block!.places) expect(["indoor", "outdoor", "going_out"]).toContain(p.g);
    expect(Object.keys(out.index)).toEqual(ids);
    expect(wishPlacePicks(sel).length).toBe(ids.length + 1);
  });

  it("local cuisine in DE: only German/regional restaurants, at most 12, r ids, no fast food", () => {
    const out = restaurantsInput(restaurants, { cuisine: { local: true, include: [], exclude: [] }, countryCode: "DE", known: new Map(), startN: 0 });
    const list = out.block!.list;
    expect(out.block!.s).toBe("ok");
    expect(out.block!.ask).toEqual({ local: true });
    expect(list.length).toBeGreaterThan(2);
    expect(list.length).toBeLessThanOrEqual(MAX_RESTAURANTS);
    expect(list[0].id).toBe("r1");
    for (const r of list) expect(r.c!.split(";").some((c) => LOCAL_CUISINE.DE.includes(c))).toBe(true);
    expect(out.index.r1.place).toMatchObject({ category: "amenity=restaurant", source: "osm", fetchedAt: T });
  });

  it("without a cuisine wish, fast food is dropped; tooFew is set for a narrow wish; errors carry no list", () => {
    const plain = restaurantsInput(restaurants, { countryCode: "DE", known: new Map(), startN: 0 });
    for (const r of plain.block!.list) expect((r.c ?? "").split(";").some((c) => FAST_FOOD_CUISINES.has(c))).toBe(false);
    expect(plain.block!.ask).toBeUndefined();
    const narrow = restaurantsInput(restaurants, { cuisine: { local: false, include: ["korean"], exclude: [] }, countryCode: "DE", known: new Map(), startN: 3 });
    expect(narrow.block!.s).toBe("ok");
    expect(narrow.block!.tooFew).toBe(true);
    if (narrow.block!.list.length) expect(narrow.block!.list[0].id).toBe("r4");
    const failed = restaurantsInput({ status: "error", restaurants: [] }, { countryCode: "DE", known: new Map(), startN: 0 });
    expect(failed.block).toEqual({ s: "error", list: [] });
    expect(restaurantsInput(undefined, { known: new Map(), startN: 0 }).block).toBeUndefined();
  });

  it("maxId finds the highest number of a prefix", () => {
    expect(maxId({ a1: 1, a12: 1, r3: 1, p40: 1 }, "a")).toBe(12);
    expect(maxId({}, "r")).toBe(0);
  });
});

describe("refs to activity places and restaurants assemble like other places", () => {
  const acts = activitiesInput(selectWishPlaces([indoor], [escapeIdea]), { lang: "de", known: new Map(), startN: 0 });
  const rest = restaurantsInput(restaurants, { cuisine: { local: true, include: [], exclude: [] }, countryCode: "DE", known: new Map(), startN: 0 });
  const index = { ...acts.index, ...rest.index };

  it("a and r ids resolve, alts too; unknown ids are counted", () => {
    const issues = emptyIssues();
    const day: PlanDay = assembleDay(
      {
        n: 1,
        title: "Ankunft",
        stops: [
          {
            place: "Würzburg",
            acts: [
              { at: "19:00", kind: "food", text: "Fränkisch essen", ref: "r1", alts: ["r2", "r3"] },
              { at: "21:00", kind: "do", text: "Escape Room", ref: "a1", alts: ["a2", "a99"] },
            ],
          },
        ],
      },
      { date: null, index, fallbackPlace: "Würzburg", issues, noteTimes: new Set() },
    );
    const [meal, evening] = day.stops[0].acts;
    expect(meal.ref).toBe(index.r1.key);
    expect(meal.alts).toEqual([index.r2.key, index.r3.key]);
    expect(evening.ref).toBe(index.a1.key);
    expect(evening.alts).toEqual([index.a2.key]);
    expect(issues.invalid_ref).toBe(1);
    const places = referencedPlaces([day], index);
    expect(places[index.r1.key].category).toBe("amenity=restaurant");
    expect(Object.keys(places)).toHaveLength(5);
  });
});

describe("pending and drive picks", () => {
  const base = { places: { status: "ok", data: { radiusKm: 15, groups: [], customInterests: [] }, source: "osm", fetchedAt: T, stale: false } } as Pick<TripFacts, "places">;

  it("only failed lookups are pending, never empty or skipped ones", () => {
    expect(activityPlacesPending({ activities: [indoor, { group: "outdoor", status: "error", places: [] }], restaurants: { status: "error", restaurants: [] } })).toEqual([
      "activities:outdoor",
      "restaurants",
    ]);
    expect(allPlacesPending({ ...base, activities: [{ group: "outdoor", status: "skipped", places: [] }], restaurants: { status: "empty", restaurants: [] } })).toBeNull();
  });

  it("activity places get drive times after the interest places; restaurants none", () => {
    const facts = { ...base, activities: [indoor], restaurants } as unknown as TripFacts;
    const picks = drivePicks(facts, { guided: {}, tags: { v: 2, interests: [], custom: [], hard: [], soft: [], summary: "", activities: [escapeIdea] } });
    expect(picks.length).toBeGreaterThan(0);
    const keys = new Set(restaurants.restaurants.map((r) => `${r.osmType}/${r.osmId}`));
    expect(picks.some((p) => keys.has(p.key))).toBe(false);
  });
});
