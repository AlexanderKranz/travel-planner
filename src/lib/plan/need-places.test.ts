import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ActivityGroupLookup, PlaceGroup, RestaurantLookup } from "@/lib/domain/facts";
import type { NeedPlaces } from "@/lib/domain/plan";
import { activityPlacesForGroup } from "@/lib/facts/activity-places";
import { toRestaurants } from "@/lib/facts/cuisine";
import { INTEREST_SOURCES, MAX_INTEREST_QUERIES, type InterestSource } from "@/lib/facts/interest-sources";
import { rankCandidates } from "@/lib/facts/places";
import { parseElements } from "@/lib/integrations/overpass";
import { restaurantsInput } from "./activities-input";
import { planInputHash } from "./hash";
import type { PlanInputStored } from "./input";
import { FEEDBACK_WISH, NEED_INTEREST_PLACES, extendInput, mergeCuisine, resolveNeedPlaces } from "./need-places";
import { storedFor } from "./test-helpers";

vi.mock("server-only", () => ({}));

const fixture = (f: string) =>
  parseElements(JSON.parse(readFileSync(new URL(`../integrations/__fixtures__/overpass/${f}`, import.meta.url), "utf8")));
const WUE = { lat: 49.791, lon: 9.953 };
const T = "2026-11-06T00:00:00.000Z";
const indoor: ActivityGroupLookup = { group: "indoor", status: "ok", places: activityPlacesForGroup("indoor", fixture("indoor-wuerzburg-15km.json"), WUE), fetchedAt: T };
const restaurants: RestaurantLookup = { status: "ok", restaurants: toRestaurants(fixture("restaurants-wuerzburg-2.5km.json"), WUE, 2.5), radiusKm: 2.5, fetchedAt: T };

describe("resolveNeedPlaces", () => {
  const stored = storedFor(2);
  it("keeps catalogue types with their groups and a near id of the input", () => {
    const r = resolveNeedPlaces({ types: ["escape_game", "rowing"], restaurants: { near: "p2", cuisine: { local: true } } }, stored);
    expect(r).toEqual({
      types: ["escape_game", "rowing"],
      groups: ["indoor", "outdoor"],
      restaurants: { cuisine: { local: true, include: [], exclude: [] }, near: { id: "p2", lat: 36.5, lon: -4.9 } },
    });
  });

  it("ignores an unknown near id and returns null when nothing is loadable", () => {
    expect(resolveNeedPlaces({ restaurants: { near: "a77" } }, stored)).toEqual({ types: [], groups: [], restaurants: {} });
    expect(resolveNeedPlaces({}, stored)).toBeNull();
    expect(resolveNeedPlaces(undefined, stored)).toBeNull();
  });
});

describe("extendInput", () => {
  const base = storedFor(2);

  it("adds a FEEDBACK wish with new a ids and keeps every old index entry", () => {
    const req = resolveNeedPlaces({ types: ["escape_game"] }, base)!;
    const next = extendInput(base, req, { activities: [indoor] }, { lang: "de", countryCode: "DE" });
    const wish = next.llm.activities!.wishes[0];
    expect(wish.w).toBe(FEEDBACK_WISH);
    expect(wish.types[0]).toMatchObject({ t: "escape_game", s: "ok" });
    expect(wish.types[0].ids![0]).toBe("a1");
    expect(next.index.p1).toEqual(base.index.p1);
    expect(next.index.a1.place.category).toBe("leisure=escape_game");
    expect(planInputHash(next.llm)).not.toBe(planInputHash(base.llm));
    expect(base.llm.activities).toBeUndefined(); // pure
  });

  it("numbers after existing ids, so earlier refs stay valid", () => {
    const req = resolveNeedPlaces({ types: ["escape_game"] }, base)!;
    const once = extendInput(base, req, { activities: [indoor] }, { lang: "de" });
    const twice = extendInput(once, resolveNeedPlaces({ types: ["bowling"] }, once)!, { activities: [indoor] }, { lang: "de" });
    const firstIds = Object.keys(once.index).filter((k) => k.startsWith("a"));
    for (const id of firstIds) expect(twice.index[id]).toEqual(once.index[id]);
    expect(twice.llm.activities!.wishes).toHaveLength(2);
    expect(twice.llm.activities!.wishes[1].types[0].ids?.every((id) => !firstIds.includes(id) || once.index[id].key === twice.index[id].key)).toBe(true);
  });

  it("restaurants at the destination replace the block (keeping the old cuisine wish); near goes to restaurantsNear", () => {
    const withRest = { ...base, llm: { ...base.llm, restaurants: { s: "ok" as const, ask: { local: true as const }, list: [] } } };
    const req = resolveNeedPlaces({ restaurants: {} }, withRest)!;
    const next = extendInput(withRest, req, { activities: [], restaurants }, { lang: "de", countryCode: "DE" });
    expect(next.llm.restaurants!.ask).toEqual({ local: true });
    expect(next.llm.restaurants!.list.length).toBeGreaterThan(0);
    const near = extendInput(withRest, resolveNeedPlaces({ restaurants: { near: "p1" } }, withRest)!, { activities: [], restaurants }, { lang: "de", countryCode: "DE" });
    expect(near.llm.restaurantsNear!.near).toBe("p1");
    expect(near.llm.restaurants).toEqual(withRest.llm.restaurants);
  });

  it("restaurant ids continue after existing r ids", () => {
    const first = restaurantsInput(restaurants, { countryCode: "DE", known: new Map(), startN: 0 });
    const stored = { ...base, llm: { ...base.llm, restaurants: first.block }, index: { ...base.index, ...first.index } };
    const next = extendInput(stored, resolveNeedPlaces({ restaurants: { cuisine: { include: ["italian"] } } }, stored)!, { activities: [], restaurants }, { lang: "de", countryCode: "DE" });
    const fresh = next.llm.restaurants!.list.filter((r) => !stored.index[r.id]);
    const max = Math.max(...Object.keys(first.index).map((k) => Number(k.slice(1))));
    for (const r of fresh) expect(Number(r.id.slice(1))).toBeGreaterThan(max);
  });
});

describe("QA: model-supplied ids and cuisine merge", () => {
  const base = storedFor(2);
  it("near never resolves inherited keys such as constructor or __proto__", () => {
    for (const near of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(resolveNeedPlaces({ restaurants: { near } }, base)).toEqual({ types: [], groups: [], restaurants: {} });
    }
  });

  it("mergeCuisine keeps local, include and exclude the request leaves unset", () => {
    expect(mergeCuisine({ local: true, exclude: ["pizza"] }, { include: ["italian"], exclude: [] })).toEqual({ local: true, include: ["italian"], exclude: ["pizza"] });
    expect(mergeCuisine({ local: true, include: ["regional"] }, { local: false, include: [], exclude: ["kebab"] })).toEqual({ local: false, include: ["regional"], exclude: ["kebab"] });
    expect(mergeCuisine(undefined, { include: ["sushi"], exclude: [] })).toEqual({ local: false, include: ["sushi"], exclude: [] });
    expect(mergeCuisine(undefined, undefined)).toBeUndefined();
  });

  it("extendInput: a request without local keeps the earlier local wish and exclusions", () => {
    const withRest = { ...base, llm: { ...base.llm, restaurants: { s: "ok" as const, ask: { local: true as const, exclude: ["pizza"] }, list: [] } } };
    const req = resolveNeedPlaces({ restaurants: { cuisine: { include: ["italian"] } } }, withRest)!;
    const next = extendInput(withRest, req, { activities: [], restaurants }, { lang: "de", countryCode: "DE" });
    expect(next.llm.restaurants!.ask).toEqual({ local: true, include: ["italian"], exclude: ["pizza"] });
  });
});

describe("needPlaces interests (issue #151)", () => {
  const MARBELLA = { lat: 36.51, lon: -4.886 };
  const golfSrc = INTEREST_SOURCES.golf as Extract<InterestSource, { source: "osm" }>;
  const golf = rankCandidates(fixture("golf-marbella-40km.json"), golfSrc.filters, MARBELLA, golfSrc.exclude, 40, { markOpenAir: true });
  const groups: PlaceGroup[] = [{ interest: "golf", status: "ok", candidates: golf, fetchedAt: T, stale: false }];
  const withPlaces = (): PlanInputStored => {
    const s = storedFor(3);
    return { ...s, llm: { ...s.llm, places: [{ id: "p1", name: "Aloha", cat: "tourism=attraction", km: 1, i: "general" }], noSource: ["golf", "nightlife"] } };
  };

  it("keeps interests with a place source only, deduped and capped like the plan's interest queries", () => {
    const stored = withPlaces();
    expect(resolveNeedPlaces({ interests: ["golf", "golf"] }, stored)).toEqual({ types: [], groups: [], interests: ["golf"] });
    // christmas_markets and nightlife have no source: nothing loadable is left.
    expect(resolveNeedPlaces({ interests: ["christmas_markets", "nightlife"] }, stored)).toBeNull();
    const many = resolveNeedPlaces({ interests: ["golf", "beach", "museums", "wellness", "history"] }, stored)!;
    expect(many.interests).toHaveLength(MAX_INTEREST_QUERIES);
    // A model-supplied prototype key never resolves.
    expect(resolveNeedPlaces({ interests: ["constructor", "__proto__", "toString"] } as unknown as NeedPlaces, stored)).toBeNull();
    expect(resolveNeedPlaces({ types: ["bowling"], interests: ["beach"] }, stored)).toEqual({ types: ["bowling"], groups: ["indoor"], interests: ["beach"] });
  });

  it("adds the loaded places after the highest p id with their interest, source and check date; leaves noSource", () => {
    const stored = withPlaces();
    const req = resolveNeedPlaces({ interests: ["golf"] }, stored)!;
    const next = extendInput(stored, req, { activities: [], interests: groups }, { lang: "de" });
    const added = next.llm.places.slice(1);
    expect(golf.length).toBeGreaterThan(0);
    expect(added.length).toBe(Math.min(NEED_INTEREST_PLACES, golf.length));
    expect(added[0]).toMatchObject({ id: "p4", i: "golf", cat: "leisure=golf_course" });
    expect(next.index.p4.place).toMatchObject({ source: "osm", fetchedAt: T, category: "leisure=golf_course" });
    expect(next.llm.noSource).toEqual(["nightlife"]);
    // Earlier entries stay, so refs of untouched days remain valid; the stored input is not mutated.
    expect(next.index.p1).toEqual(stored.index.p1);
    expect(stored.llm.places).toHaveLength(1);
    // A second request skips places already listed and keeps numbering.
    const again = extendInput(next, req, { activities: [], interests: groups }, { lang: "de" });
    const ids = again.llm.places.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(Object.values(again.index).map((e) => e.key)).size).toBe(Object.keys(again.index).length);
  });

  it("an interest that found nothing (or could not load, e.g. a free-text destination) goes to noSource", () => {
    const s = storedFor(3);
    const req = resolveNeedPlaces({ interests: ["golf", "beach"] }, s)!;
    const next = extendInput(s, req, { activities: [], interests: [{ interest: "golf", status: "empty", fetchedAt: T, stale: false }] }, { lang: "de" });
    expect(next.llm.places).toEqual([]);
    expect(next.llm.noSource).toEqual(["golf", "beach"]);
  });
});
