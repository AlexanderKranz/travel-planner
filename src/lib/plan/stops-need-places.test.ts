import { describe, expect, it, vi } from "vitest";
import type { CafeLookup, RestaurantLookup } from "@/lib/domain/facts";
import { extendInput, hasUnknownNear, resolveNeedPlaces } from "./need-places";
import type { PlanInputStored } from "./input";
import { extendInputWithStops, stopPointsOf, stopRows } from "./stops-input";
import { CRUISE_FACTS, CRUISE_RESOLVED, CRUISE_STOPS, T, WIEN, emptyStored, rest } from "./stops-test-helpers";

vi.mock("server-only", () => ({}));

const stored = (): PlanInputStored =>
  extendInputWithStops(emptyStored(), { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf(CRUISE_RESOLVED), facts: CRUISE_FACTS, lang: "de" });

describe("needPlaces.near = a stop id (port-places [P8])", () => {
  it("resolves to the stop point and marks the request as around a stop", () => {
    const r = resolveNeedPlaces({ restaurants: { near: "s1", cuisine: { include: ["italian"] } }, cafes: { near: "s2" } }, stored())!;
    expect(r.restaurants!.near).toEqual({ id: "s1", lat: WIEN.lat, lon: WIEN.lon, stop: true });
    expect(r.cafes!.near).toMatchObject({ id: "s2", stop: true });
  });

  it("an input place id still resolves as before, without `stop`", () => {
    expect(resolveNeedPlaces({ restaurants: { near: "p1" } }, stored())!.restaurants!.near).toEqual({ id: "p1", lat: expect.any(Number), lon: expect.any(Number) });
  });

  it("an unknown near no longer falls back to the destination: the request is unusable", () => {
    expect(resolveNeedPlaces({ restaurants: { near: "s7" } }, stored())).toBeNull();
    expect(resolveNeedPlaces({ restaurants: { near: "s1" }, cafes: { near: "zz" } }, stored())).toBeNull();
    expect(hasUnknownNear({ restaurants: { near: "s7" } }, stored())).toBe(true);
    expect(hasUnknownNear({ restaurants: { near: "s1" } }, stored())).toBe(false);
    expect(hasUnknownNear({ restaurants: {} }, stored())).toBe(false);
    expect(hasUnknownNear(undefined, stored())).toBe(false);
  });

  it("a stop without a point (not found) is unknown too", () => {
    const s = stored();
    s.llm.stopPlaces = [...s.llm.stopPlaces!, { id: "s3", name: "Nirgendwo", s: "not_found" }];
    expect(resolveNeedPlaces({ restaurants: { near: "s3" } }, s)).toBeNull();
  });

  it("extendInput replaces that stop's restaurants, keeps the destination's block, tags the new entries with the stop", () => {
    const s = stored();
    const req = resolveNeedPlaces({ restaurants: { near: "s1", cuisine: { include: ["italian"] } } }, s)!;
    const loaded: RestaurantLookup = {
      status: "ok",
      restaurants: [rest(201, "Beisl Wien", 48.209, 16.37, 0.5, ["austrian"]), rest(801, "Trattoria", 48.21, 16.371, 0.6, ["italian"]), rest(802, "Osteria", 48.21, 16.372, 0.7, ["italian"])],
      radiusKm: 2.5,
      fetchedAt: T,
    };
    const next = extendInput(s, req, { activities: [], restaurants: loaded }, { lang: "de", countryCode: "AT" });
    const wien = next.llm.stopPlaces![0];
    expect(wien.restaurants!.list.map((x) => x.name)).toEqual(["Trattoria", "Osteria"]);
    expect("ask" in wien.restaurants!).toBe(false);
    expect("near" in wien.restaurants!).toBe(false);
    expect(next.llm.restaurantsNear).toBeUndefined();
    expect(next.llm.restaurants).toBe(s.llm.restaurants);
    const newIds = wien.restaurants!.list.map((x) => x.id);
    for (const id of newIds) expect(next.index[id].stop).toBe("s1");
    // ids continue after the highest r id; every old entry stays
    expect(newIds.every((id) => !(id in s.index))).toBe(true);
    for (const id of Object.keys(s.index)) expect(next.index[id]).toEqual(s.index[id]);
    expect(next.llm.stopPlaces![1]).toEqual(s.llm.stopPlaces![1]);
  });

  it("extendInput replaces that stop's cafés", () => {
    const s = stored();
    const req = resolveNeedPlaces({ cafes: { near: "s2" } }, s)!;
    const loaded: CafeLookup = { status: "ok", cafes: [rest(901, "Kaffeehaus", 48.395, 15.52, 0.2)], radiusKm: 2.5, fetchedAt: T };
    const next = extendInput(s, req, { activities: [], cafes: loaded }, { lang: "de" });
    expect(next.llm.stopPlaces![1].cafes).toEqual({ s: "ok", list: [{ id: expect.stringMatching(/^c\d+$/), name: "Kaffeehaus", km: 0.2 }] });
    expect(next.llm.cafes).toBeUndefined();
  });
});
