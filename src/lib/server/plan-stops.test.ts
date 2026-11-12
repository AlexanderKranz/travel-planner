import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  resolveStops: vi.fn(),
  getStopFacts: vi.fn(),
  lookupStops: vi.fn(),
  resolveStopPlaces: vi.fn(),
  drive: vi.fn(),
  enqueue: vi.fn(async () => {}),
}));
vi.mock("./trip-stops", () => ({ resolveTripStops: h.resolveStops }));
vi.mock("./facts/stops", () => ({ getStopFacts: h.getStopFacts, lookupStops: h.lookupStops, resolveStopPlaces: h.resolveStopPlaces, stopDriveTimes: h.drive }));
vi.mock("./place-retries", () => ({ enqueuePlaceRetries: h.enqueue }));

import type { StopFacts } from "@/lib/domain/facts";
import type { Trip } from "@/lib/domain/trip";
import { extendInputWithStops, stopPointsOf, stopRows } from "@/lib/plan/stops-input";
import { CRUISE_FACTS, CRUISE_RESOLVED, CRUISE_STOPS, cand, emptyStored, group } from "@/lib/plan/stops-test-helpers";
import { STOP_PREP_MAX_MS, prepareStopsForPatch, stopPrepBudget } from "./plan-stops";

const trip = { destination: { kind: "region", countryCode: "DE" } } as unknown as Trip;
const run = (input = emptyStored(), over: Record<string, unknown> = {}) =>
  prepareStopsForPatch({ trip, purpose: null, input, scopeDays: [], locale: "de", userId: "u1", budgetMs: 30_000, ...over });
const upgraded = () => extendInputWithStops(emptyStored(), { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf(CRUISE_RESOLVED), facts: CRUISE_FACTS, lang: "de" });

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveStops.mockResolvedValue([]);
  h.getStopFacts.mockResolvedValue([]);
  h.lookupStops.mockResolvedValue([]);
  h.resolveStopPlaces.mockResolvedValue([]);
  h.drive.mockResolvedValue({});
});

describe("stopPrepBudget (port-places section 4)", () => {
  it("min(30 s, time left - 240 s): the needPlaces deadline stays intact", () => {
    expect(stopPrepBudget(270_000)).toBe(STOP_PREP_MAX_MS);
    expect(stopPrepBudget(255_000)).toBe(15_000);
    expect(stopPrepBudget(240_000)).toBe(0);
    expect(stopPrepBudget(100_000)).toBeLessThan(0);
  });
});

describe("prepareStopsForPatch", () => {
  it("a trip without stops: nothing to do, the input is returned as it is", async () => {
    const input = emptyStored();
    const r = await run(input);
    expect(r).toEqual({ stored: input, upgraded: false, retried: 0, tripHasStops: false });
    expect(h.getStopFacts).not.toHaveBeenCalled();
  });

  it("upgrades an input from before plan-8: geocode and look up (cache + Geoapify only), add rows and stop places, queue retries", async () => {
    h.resolveStops.mockResolvedValue(CRUISE_STOPS);
    h.getStopFacts.mockResolvedValue(CRUISE_FACTS);
    h.drive.mockResolvedValue({ s1: { byKey: { "node/101": { min: 12, km: 9 } }, fetchedAt: "f" } });
    const r = await run();
    expect(r.upgraded).toBe(true);
    expect(r.tripHasStops).toBe(true);
    expect(h.getStopFacts).toHaveBeenCalledWith(trip, CRUISE_STOPS, null, expect.anything(), { budgetMs: expect.any(Number), overpass: "cache_only" });
    expect(r.stored.llm.trip.stops).toHaveLength(5);
    expect(r.stored.llm.stopPlaces!.map((p) => p.id)).toEqual(["s1", "s2"]);
    expect(r.stored.stopPoints).toBeDefined();
    expect(r.stored.index.p2.place.drive).toMatchObject({ min: 12, from: "Wien" });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it("an input that already has stops is not upgraded again", async () => {
    h.resolveStops.mockResolvedValue(CRUISE_STOPS);
    const r = await run(upgraded());
    expect(r.upgraded).toBe(false);
    expect(h.resolveStops).not.toHaveBeenCalled();
    expect(r.tripHasStops).toBe(true);
  });

  it("retries failed stops in scope only, replaces their entries, queues what still fails", async () => {
    const failed: StopFacts = { ...CRUISE_FACTS[2], places: [], restaurants: { status: "error", restaurants: [] } };
    const input = extendInputWithStops(emptyStored(), { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf(CRUISE_RESOLVED), facts: [CRUISE_FACTS[1], failed], lang: "de" });
    h.lookupStops.mockResolvedValue([CRUISE_FACTS[2]]);
    const r = await run(input, { scopeDays: [3] });
    expect(r.retried).toBe(1);
    expect(h.lookupStops.mock.calls[0][0]).toEqual([expect.objectContaining({ id: "s2", name: "Dürnstein" })]);
    expect(h.lookupStops.mock.calls[0][3]).toMatchObject({ overpass: "cache_only" });
    expect(r.stored.llm.stopPlaces![1].s).toBeUndefined();
    expect(r.stored.llm.stopPlaces![1].restaurants!.list[0].name).toBe("Weinstube");

    h.lookupStops.mockClear();
    const out = await run(input, { scopeDays: [2] }); // day 2 is Wien, which is fine
    expect(out.retried).toBe(0);
    expect(h.lookupStops).not.toHaveBeenCalled();
  });

  it("stops in scope without sights are looked up again (cache + Geoapify) and the patch input gets their sights", async () => {
    const noSights: StopFacts = { ...CRUISE_FACTS[1], places: [group("nature_wildlife", [cand(111, "Lobau", 48.17, 16.5, "leisure=nature_reserve")])] };
    const input = extendInputWithStops(emptyStored(), { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf(CRUISE_RESOLVED), facts: [noSights], lang: "de" });
    const withSights: StopFacts = { ...noSights, places: [noSights.places[0], group("general", [cand(103, "Stephansdom", 48.2086, 16.3731, "building=cathedral")])] };
    h.lookupStops.mockResolvedValue([withSights]);
    const r = await run(input, { purpose: { guided: null, tags: { interests: ["nature_wildlife", "photography"] } } });
    expect(h.lookupStops.mock.calls[0][0]).toEqual([expect.objectContaining({ id: "s1", name: "Wien", status: "ok" })]);
    expect(h.lookupStops.mock.calls[0][3]).toMatchObject({ overpass: "cache_only" });
    expect(r.retried).toBe(1);
    expect(r.stored.llm.stopPlaces![0].places!.map((p) => [p.name, p.i])).toEqual([["Lobau", "nature_wildlife"], ["Stephansdom", "general"]]);

    // Out of scope (day 3 only, no Wien row): not looked up.
    h.lookupStops.mockClear();
    expect((await run(input, { scopeDays: [3] })).retried).toBe(0);
    expect(h.lookupStops).not.toHaveBeenCalled();
  });

  it("a stop whose geocoding failed is geocoded again, then looked up like any retry", async () => {
    const failedGeo = { ...CRUISE_RESOLVED[2], status: "error" as const, point: undefined };
    const input = extendInputWithStops(emptyStored(), { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf([CRUISE_RESOLVED[1]]), facts: [CRUISE_FACTS[1], { stop: failedGeo, places: [] }], lang: "de" });
    expect(input.llm.stopPlaces![1].s).toBe("error");
    expect(input.stopPoints!.s2).toBeUndefined();
    h.resolveStopPlaces.mockResolvedValue([{ ...CRUISE_RESOLVED[2], id: "s1" }]);
    h.lookupStops.mockResolvedValue([CRUISE_FACTS[2]]);
    const r = await run(input, { scopeDays: [3] });
    expect(h.resolveStopPlaces).toHaveBeenCalledTimes(1);
    expect(h.resolveStopPlaces.mock.calls[0][1]).toEqual([{ day: 3, place: "Dürnstein" }]);
    expect(h.lookupStops.mock.calls[0][0]).toEqual([expect.objectContaining({ id: "s2", status: "ok" })]);
    expect(r.retried).toBe(1);
    expect(r.stored.stopPoints!.s2).toMatchObject({ geoId: 2780900 });
  });

  it("the geocoding retry passes the typed stop's country hint and stores the found country (#187)", async () => {
    const failedGeo = { ...CRUISE_RESOLVED[2], status: "error" as const, point: undefined };
    const input = extendInputWithStops(emptyStored(), { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf([CRUISE_RESOLVED[1]]), facts: [CRUISE_FACTS[1], { stop: failedGeo, places: [] }], lang: "de" });
    h.resolveStopPlaces.mockResolvedValue([{ ...CRUISE_RESOLVED[2], id: "s1", countryCode: "AT" }]);
    h.lookupStops.mockResolvedValue([CRUISE_FACTS[2]]);
    const withCc = { ...trip, stops: [{ day: 3, place: "Dürnstein", cc: "AT" }] };
    const r = await run(input, { scopeDays: [3], trip: withCc });
    expect(h.resolveStopPlaces.mock.calls[0][1]).toEqual([{ day: 3, place: "Dürnstein", cc: "AT" }]);
    expect(r.stored.stopPoints!.s2).toMatchObject({ cc: "AT" });
  });

  it("a geocoding retry that fails again leaves the stop as it was", async () => {
    const failedGeo = { ...CRUISE_RESOLVED[2], status: "error" as const, point: undefined };
    const input = extendInputWithStops(emptyStored(), { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf([CRUISE_RESOLVED[1]]), facts: [CRUISE_FACTS[1], { stop: failedGeo, places: [] }], lang: "de" });
    h.resolveStopPlaces.mockResolvedValue([{ ...failedGeo, id: "s1" }]);
    const r = await run(input);
    expect(r.retried).toBe(0);
    expect(h.lookupStops).not.toHaveBeenCalled();
  });

  it("no budget left: nothing is looked up, the input stays", async () => {
    h.resolveStops.mockResolvedValue(CRUISE_STOPS);
    const input = emptyStored();
    expect((await run(input, { budgetMs: 0 })).stored).toBe(input);
    expect(h.getStopFacts).not.toHaveBeenCalled();
  });

  it("never throws: any failure leaves the input as it was", async () => {
    h.resolveStops.mockRejectedValue(new Error("boom"));
    const input = emptyStored();
    expect(await run(input)).toMatchObject({ stored: input, upgraded: false });
  });
});
