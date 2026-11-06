/** Addendum 1 wiring (activities spec): cafés block, kids tags only when asked, needPlaces for cafés and kids. */
import { describe, expect, it, vi } from "vitest";
import type { ActivityGroupLookup, CafeLookup, RestaurantLookup } from "@/lib/domain/facts";
import type { Restaurant } from "@/lib/facts/cuisine";
import { MAX_CAFES } from "@/lib/facts/cuisine";
import { cafesInput, lookupTypeStatus, restaurantsInput, selectWishPlaces } from "./activities-input";
import { extendInput, mergeCuisine, resolveNeedPlaces } from "./need-places";
import { activityPlacesPending, allPlacesPending, blockingScope } from "./places-pending";
import { wishedTypes } from "@/lib/facts/activity-types";

const placesOk = { places: { status: "ok" as const, data: { radiusKm: 15, groups: [], customInterests: [] }, source: "osm" as const, fetchedAt: "2026-11-06T00:00:00.000Z", stale: false } };
import { storedFor } from "./test-helpers";

vi.mock("server-only", () => ({}));

const T = "2026-11-06T00:00:00.000Z";
let n = 0;
const spot = (name: string, extra: Partial<Restaurant> = {}): Restaurant => ({
  osmType: "node", osmId: ++n, name, cuisines: ["german"], lat: 50.38, lon: 8.06, distanceKm: 0.5, hasOpeningHours: false, kidsTagged: false,
  osmUrl: `https://www.openstreetmap.org/node/${n}`, ...extra,
});
const rest: RestaurantLookup = {
  status: "ok",
  restaurants: [spot("Near", { distanceKm: 0.1, website: "https://x.test" }), spot("Kids", { distanceKm: 2, kidsTagged: true }), spot("Mid", { distanceKm: 1 })],
  radiusKm: 2.5,
  fetchedAt: T,
};
const cafeList = Array.from({ length: 8 }, (_, i) => spot(`Café ${i}`, { cuisines: ["coffee_shop"], distanceKm: i / 10, kidsTagged: i === 7 }));
const cafes: CafeLookup = { status: "ok", cafes: cafeList, radiusKm: 2.5, fetchedAt: T };

describe("restaurants: kids tags reach the model only with ask.kids (A4)", () => {
  it("without kids: no k, no kids in ask, ranking ignores the tags", () => {
    const r = restaurantsInput(rest, { cuisine: { local: true }, countryCode: "DE", known: new Map(), startN: 0 });
    expect(r.block!.ask).toEqual({ local: true });
    expect(r.block!.list.map((x) => x.name)).toEqual(["Near", "Mid", "Kids"]);
    expect(r.block!.list.some((x) => "k" in x)).toBe(false);
  });
  it("with kids: tagged first with k, ask.kids set, nothing dropped", () => {
    const r = restaurantsInput(rest, { cuisine: { kids: true }, countryCode: "DE", known: new Map(), startN: 0 });
    expect(r.block!.ask).toEqual({ kids: true });
    expect(r.block!.list).toEqual([
      { id: "r1", name: "Kids", c: "german", km: 2, k: true },
      { id: "r2", name: "Near", c: "german", km: 0.1 },
      { id: "r3", name: "Mid", c: "german", km: 1 },
    ]);
  });
});

describe("cafesInput (A2)", () => {
  it("c ids, at most 6, own category, validated through the shared index", () => {
    const c = cafesInput(cafes, { known: new Map(), startN: 0 });
    expect(c.block!.list).toHaveLength(MAX_CAFES);
    expect(c.block!.list.map((x) => x.id)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(c.block!.kids).toBeUndefined();
    expect(c.block!.list.some((x) => "k" in x)).toBe(false);
    expect(c.index.c1.place).toMatchObject({ category: "amenity=cafe", source: "osm", fetchedAt: T });
  });
  it("with kids: the tagged café ranks first and carries k", () => {
    const c = cafesInput(cafes, { kids: true, known: new Map(), startN: 0 });
    expect(c.block!.kids).toBe(true);
    expect(c.block!.list[0]).toMatchObject({ name: "Café 7", k: true });
  });
  it("a failed or empty lookup keeps its status without places; absent stays absent", () => {
    expect(cafesInput({ status: "error", cafes: [] }, { known: new Map(), startN: 0 })).toEqual({ block: { s: "error", list: [] }, index: {} });
    expect(cafesInput(undefined, { known: new Map(), startN: 0 })).toEqual({ index: {} });
  });
  it("failed or cache-only cafés are pending like restaurants", () => {
    expect(activityPlacesPending({ cafes: { status: "error", cafes: [] } })).toEqual(["cafes"]);
    expect(activityPlacesPending({ cafes: { status: "skipped", reason: "cache_only", cafes: [] } })).toEqual(["cafes"]);
    expect(activityPlacesPending({ cafes: { status: "empty", cafes: [] } })).toEqual([]);
  });
});

describe("needPlaces with cafés and kids", () => {
  const base = storedFor(2);
  it("resolves cafés (near an input id, kids only when true); a cafés-only request is loadable", () => {
    expect(resolveNeedPlaces({ cafes: { near: "p2", kids: true } }, base)).toEqual({ types: [], groups: [], cafes: { kids: true, near: { id: "p2", lat: 36.5, lon: -4.9 } } });
    expect(resolveNeedPlaces({ cafes: { near: "__proto__", kids: false } }, base)).toEqual({ types: [], groups: [], cafes: {} });
    expect(resolveNeedPlaces({ restaurants: { cuisine: { kids: true } } }, base)!.restaurants).toEqual({ cuisine: { include: [], exclude: [], kids: true } });
  });
  it("mergeCuisine keeps an earlier kids wish and lets the request set it", () => {
    expect(mergeCuisine({ local: true, kids: true }, { include: [], exclude: [] })).toEqual({ local: true, include: [], exclude: [], kids: true });
    expect(mergeCuisine({ local: true }, { include: [], exclude: [], kids: true })).toEqual({ local: true, include: [], exclude: [], kids: true });
    expect(mergeCuisine({ local: true }, { include: [], exclude: [] })).toEqual({ local: true, include: [], exclude: [] });
  });
  it("extendInput adds a CAFES block (c ids after existing ones, near kept) and keeps old index entries", () => {
    const first = cafesInput(cafes, { known: new Map(), startN: 0 });
    const stored = { ...base, llm: { ...base.llm, cafes: first.block }, index: { ...base.index, ...first.index } };
    const more: CafeLookup = { ...cafes, cafes: [spot("Neu", { cuisines: ["cake"] })] };
    const next = extendInput(stored, resolveNeedPlaces({ cafes: { near: "p1" } }, stored)!, { activities: [], cafes: more }, { lang: "de" });
    expect(next.llm.cafes).toEqual({ s: "ok", near: "p1", list: [{ id: "c7", name: "Neu", c: "cake", km: 0.5 }] });
    for (const id of Object.keys(first.index)) expect(next.index[id]).toEqual(stored.index[id]);
    expect(next.index.c7.place.category).toBe("amenity=cafe");
  });
  it("extendInput: kids restaurants put k on the list; cafés inherit kids from the restaurant wish", () => {
    const req = resolveNeedPlaces({ restaurants: { cuisine: { kids: true } }, cafes: {} }, base)!;
    const next = extendInput(base, req, { activities: [], restaurants: rest, cafes }, { lang: "de", countryCode: "DE" });
    expect(next.llm.restaurants!.ask).toEqual({ kids: true });
    expect(next.llm.restaurants!.list[0]).toMatchObject({ name: "Kids", k: true });
    expect(next.llm.cafes!.kids).toBe(true);
  });
});

describe("resolveNeedPlaces with the wire defaults (QA #137)", () => {
  it('near "" and kids false resolve to a plain cafés / restaurants request', () => {
    const base = storedFor(2);
    expect(resolveNeedPlaces({ cafes: { near: "", kids: false } }, base)).toEqual({ types: [], groups: [], cafes: {} });
    expect(resolveNeedPlaces({ restaurants: { near: "", cuisine: { kids: false } } }, base)).toEqual({ types: [], groups: [], restaurants: {} });
  });
});

describe("per-type status (Addendum 3)", () => {
  const place = (osmId: number, types: ("escape_game" | "karaoke" | "bowling")[]) => ({
    types, group: "indoor" as const, osmType: "node" as const, osmId, name: `P${osmId}`, names: {}, category: "leisure=escape_game",
    lat: 50, lon: 8, distanceKm: 1, osmUrl: `https://www.openstreetmap.org/node/${osmId}`,
  });
  const partial: ActivityGroupLookup = {
    group: "indoor", status: "ok", partial: true, fetchedAt: T, places: [place(1, ["escape_game"])],
    typeStatus: { escape_game: "ok", bowling: "empty", karaoke: "error", cinema: "cut" },
  };
  const wish = { types: ["escape_game", "karaoke", "bowling", "cinema"] as const, open: false };
  const statuses = (look: ActivityGroupLookup) =>
    Object.fromEntries(selectWishPlaces([look], [{ ...wish, types: [...wish.types] }])[0].types.map((t) => [t.t, [t.s, t.places.length]]));

  it("a partial group keeps the working part's places; each type gets its own status", () => {
    expect(statuses(partial)).toEqual({ escape_game: ["ok", 1], karaoke: ["error", 0], bowling: ["empty", 0], cinema: ["cut", 0] });
  });
  it("old lookups without typeStatus derive it from the group status", () => {
    expect(lookupTypeStatus({ group: "indoor", status: "ok", places: [place(1, ["escape_game"])] }, "bowling")).toBe("empty");
    expect(lookupTypeStatus({ group: "indoor", status: "ok", truncated: true, places: [] }, "bowling")).toBe("cut");
    expect(lookupTypeStatus({ group: "indoor", status: "error", places: [] }, "bowling")).toBe("error");
    expect(lookupTypeStatus(undefined, "bowling")).toBe("skipped");
  });
  it("typeStatus ok without a place in the list (group cap) is never a false empty", () => {
    expect(statuses({ ...partial, partial: undefined, typeStatus: { escape_game: "ok", karaoke: "ok", bowling: "ok", cinema: "ok" } }).bowling).toEqual(["cut", 0]);
  });
  it("a type whose only place is listed under another type reuses it (no false empty)", () => {
    const shared: ActivityGroupLookup = { group: "indoor", status: "ok", fetchedAt: T, places: [place(1, ["escape_game", "bowling"])] };
    expect(statuses(shared).bowling).toEqual(["ok", 1]);
  });
  it("partial groups and per-type errors are pending; cut is final", () => {
    expect(activityPlacesPending({ activities: [partial] })).toEqual(["activities:indoor"]);
    expect(activityPlacesPending({ activities: [{ ...partial, partial: undefined, typeStatus: { escape_game: "ok", karaoke: "error" } }] })).toEqual(["activities:indoor"]);
    expect(activityPlacesPending({ activities: [{ ...partial, partial: undefined, typeStatus: { escape_game: "ok", cinema: "cut", bowling: "empty" } }] })).toEqual([]);
    // A part skipped for lack of time blocks; a group skipped for lack of coordinates never does.
    expect(activityPlacesPending({ activities: [{ ...partial, partial: undefined, typeStatus: { karaoke: "skipped" } }] })).toEqual(["activities:indoor"]);
    expect(activityPlacesPending({ activities: [{ group: "indoor", status: "skipped", reason: "no_location", places: [], typeStatus: { karaoke: "skipped" } }] })).toEqual([]);
    expect(activityPlacesPending({ activities: [{ ...partial, typeStatus: { escape_game: "ok", karaoke: "unrequested" } }] })).toEqual([]);
  });
  it("QA #139: only wished types can block (escape room wish, failed Overpass part with karaoke/indoor_play)", () => {
    const look: ActivityGroupLookup = { ...partial, typeStatus: { escape_game: "ok", bowling: "empty", karaoke: "error", indoor_play: "error" } };
    expect(activityPlacesPending({ activities: [look] }, new Set(["escape_game"] as const))).toEqual([]);
    expect(activityPlacesPending({ activities: [look] }, new Set(["escape_game", "karaoke"] as const))).toEqual(["activities:indoor"]);
    expect(allPlacesPending({ ...placesOk, activities: [look] }, wishedTypes([{ types: ["escape_game"], open: false }]))).toBeNull();
    // An open escape room wish only adds karaoke as an option: best effort, the failed part never blocks.
    expect(allPlacesPending({ ...placesOk, activities: [look] }, blockingScope([{ types: ["escape_game"], open: true }]))).toBeNull();
    // A named karaoke wish blocks.
    expect(allPlacesPending({ ...placesOk, activities: [look] }, blockingScope([{ types: ["karaoke"], open: true }]))).toEqual(["activities:indoor"]);
  });
  it("QA #139: a group-only open wish blocks only when no part of the group answered", () => {
    const scope = blockingScope([{ types: [], open: true, group: "indoor" }]);
    const look: ActivityGroupLookup = { ...partial, typeStatus: { escape_game: "ok", karaoke: "error" } };
    expect(activityPlacesPending({ activities: [look] }, scope)).toEqual([]);
    const failed: ActivityGroupLookup = { group: "indoor", status: "error", places: [], typeStatus: { escape_game: "error", karaoke: "error" } };
    expect(activityPlacesPending({ activities: [failed] }, scope)).toEqual(["activities:indoor"]);
  });
  it("QA #139: an open escape room wish with a failed Overpass part uses the escape room places; failed extras are not offered", () => {
    const look: ActivityGroupLookup = {
      group: "indoor", status: "ok", partial: true, fetchedAt: T, places: [place(1, ["escape_game"]), place(2, ["bowling"])],
      typeStatus: { escape_game: "ok", bowling: "ok", cinema: "empty", karaoke: "error", indoor_play: "unrequested" },
    };
    const sel = selectWishPlaces([look], [{ types: ["escape_game"], open: true }])[0].types;
    expect(sel.map((t) => [t.t, t.s, t.places.length])).toEqual([["escape_game", "ok", 1], ["bowling", "ok", 1]]);
    expect(activityPlacesPending({ activities: [look] }, blockingScope([{ types: ["escape_game"], open: true }]))).toEqual([]);
    // A group-only wish keeps the failed types visible ("could not be checked").
    const groupOnly = selectWishPlaces([look], [{ types: [], open: true, group: "indoor" }])[0].types;
    expect(groupOnly.find((t) => t.t === "karaoke")?.s).toBe("error");
  });
});
