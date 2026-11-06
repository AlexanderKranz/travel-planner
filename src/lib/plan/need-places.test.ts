import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ActivityGroupLookup, RestaurantLookup } from "@/lib/domain/facts";
import { activityPlacesForGroup } from "@/lib/facts/activity-places";
import { toRestaurants } from "@/lib/facts/cuisine";
import { parseElements } from "@/lib/integrations/overpass";
import { restaurantsInput } from "./activities-input";
import { planInputHash } from "./hash";
import { FEEDBACK_WISH, extendInput, resolveNeedPlaces } from "./need-places";
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
