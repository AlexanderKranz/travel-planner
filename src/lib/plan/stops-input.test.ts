import { describe, expect, it, vi } from "vitest";
import type { StopFacts } from "@/lib/domain/facts";
import { planInputHash } from "./hash";
import type { DriveInput, PlanIndexEntry } from "./input";
import {
  STOP_PLACES_PER_INTEREST,
  extendInputWithStops,
  resolvedFromInput,
  stopDrivePicks,
  stopLookupStatus,
  stopPending,
  stopPointsOf,
  stopRows,
  stopsInput,
  stopsToGeocode,
  stopsToRetry,
} from "./stops-input";
import { CRUISE_FACTS, CRUISE_RESOLVED, CRUISE_STOPS, T, cand, emptyStored, group, okRestaurants, rest, stopOk, storedWithStops, WIEN } from "./stops-test-helpers";

vi.mock("server-only", () => ({}));

const args = (facts: StopFacts[], over: Record<string, unknown> = {}) => {
  const stored = emptyStored();
  return { facts, lang: "de" as const, known: new Map(Object.entries(stored.index).map(([id, v]) => [v.key as string, id])), index: stored.index as Record<string, PlanIndexEntry>, ...over };
};

describe("stopRows", () => {
  it("one row per trip stop with the code-set `at`; sea rows have none", () => {
    const rows = stopRows(CRUISE_STOPS, CRUISE_RESOLVED);
    expect(rows.map((r) => [r.day, r.at])).toEqual([[1, "dest"], [2, "s1"], [3, "s2"], [4, undefined], [5, "dest"]]);
    expect(rows[1]).toEqual({ day: 2, place: "Wien", arr: "14:00", dep: "23:59", at: "s1" });
    expect(rows[3]).toEqual({ day: 4, sea: true });
    expect("at" in rows[3]).toBe(false);
  });
  it("without resolved stops there is no `at`", () => {
    expect(stopRows(CRUISE_STOPS, []).every((r) => !("at" in r))).toBe(true);
  });
});

describe("stopsInput", () => {
  it("lists places per stop with ids after the destination's p ids, no min and no ap, km from the stop", () => {
    const { stopPlaces, index } = stopsInput(args(CRUISE_FACTS));
    expect(stopPlaces.map((p) => p.id)).toEqual(["s1", "s2"]);
    const wien = stopPlaces[0];
    expect(wien.places!.map((p) => [p.id, p.name, p.i])).toEqual([
      ["p2", "Zoo Wien", "family_activities"],
      ["p3", "Haus des Meeres", "family_activities"],
      ["p4", "Stephansdom", "general"],
    ]);
    for (const p of wien.places!) expect(Object.keys(p)).toEqual(expect.not.arrayContaining(["min", "ap"]));
    expect(index.p2.stop).toBe("s1");
    expect(index.p2.place.distanceKm).toBe(1);
  });

  it("a stop's restaurants: up to 6, ids continue the r range, no ask and no near, entries tagged with the stop", () => {
    const many = Array.from({ length: 9 }, (_, i) => rest(500 + i, `R${i}`, 48.2, 16.37, 0.1 * (i + 1)));
    const facts: StopFacts[] = [{ ...CRUISE_FACTS[1], restaurants: okRestaurants(many) }];
    const { stopPlaces, index } = stopsInput(args(facts, { cuisine: { exclude: ["pizza"] } }));
    const block = stopPlaces[0].restaurants!;
    expect(block.s).toBe("ok");
    expect(block.list).toHaveLength(6);
    expect(block.list[0].id).toBe("r1");
    expect("ask" in block).toBe(false);
    expect("near" in block).toBe(false);
    expect(index.r1.stop).toBe("s1");
  });

  it("cafés only when looked up: up to 3, ids c1..", () => {
    const cafes = { status: "ok" as const, cafes: Array.from({ length: 5 }, (_, i) => rest(700 + i, `K${i}`, 48.2, 16.37, 0.2 * (i + 1))), fetchedAt: T };
    const { stopPlaces } = stopsInput(args([{ ...CRUISE_FACTS[1], cafes }, CRUISE_FACTS[2]]));
    expect(stopPlaces[0].cafes!.list.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(stopPlaces[1].cafes).toBeUndefined();
  });

  it("a place of the destination list keeps its p id when it is also listed at a stop", () => {
    const a = args([{ ...CRUISE_FACTS[1], places: [group("general", [cand(1, "Passauer Dom", 48.5665, 13.4312, "tourism=attraction", 9)])] }]);
    const { stopPlaces, index } = stopsInput(a);
    expect(stopPlaces[0].places).toEqual([{ id: "p1", name: "Passauer Dom", cat: "tourism=attraction", km: 9, i: "general" }]);
    expect(Object.keys(index).filter((k) => k.startsWith("p"))).toEqual([]); // nothing new: the place stays the destination's
  });

  it("the same place under two interests of a stop is one row; general adds nothing to a specific interest", () => {
    const facts: StopFacts[] = [{ ...CRUISE_FACTS[1], places: [group("family_activities", [cand(101, "Zoo Wien", 48.18, 16.3)]), group("general", [cand(101, "Zoo Wien", 48.18, 16.3)])] }];
    expect(stopsInput(args(facts)).stopPlaces[0].places).toHaveLength(1);
    expect(stopsInput(args(facts)).stopPlaces[0].places![0].i).toBe("family_activities");
  });

  it("at most 4 places per interest", () => {
    const facts: StopFacts[] = [{ ...CRUISE_FACTS[1], places: [group("general", Array.from({ length: 9 }, (_, i) => cand(900 + i, `P${i}`, 48.2, 16.3)))] }];
    expect(stopsInput(args(facts)).stopPlaces[0].places).toHaveLength(STOP_PLACES_PER_INTEREST);
    expect(stopDrivePicks(facts[0])).toHaveLength(STOP_PLACES_PER_INTEREST);
  });

  it("drive times from the stop: place.drive carries `from` = the stop name; the row has no min", () => {
    const drive: DriveInput = { byKey: { "node/101": { min: 12, km: 9.1 } }, fetchedAt: T };
    const { stopPlaces, index } = stopsInput(args(CRUISE_FACTS, { drive: { s1: drive } }));
    expect(index.p2.place.drive).toEqual({ min: 12, km: 9.1, source: "openrouteservice", fetchedAt: T, from: "Wien" });
    expect(stopPlaces[0].places![0]).not.toHaveProperty("min");
    expect(index.p3.place.drive).toBeUndefined(); // no result for that place
  });

  it("entries for not found, failed and capped stops carry only their status; destination stops have no entry", () => {
    const bad = (id: string, status: "not_found" | "error" | "cap"): StopFacts => ({ stop: { id, name: `X${id}`, days: [2], role: "stop", status }, places: [] });
    const { stopPlaces } = stopsInput(args([CRUISE_FACTS[0], bad("s1", "not_found"), bad("s2", "error"), bad("s3", "cap")]));
    expect(stopPlaces).toEqual([
      { id: "s1", name: "Xs1", s: "not_found" },
      { id: "s2", name: "Xs2", s: "error" },
      { id: "s3", name: "Xs3", s: "cap" },
    ]);
  });
});

describe("stop lookup status", () => {
  const failedRest = { status: "error" as const, restaurants: [] };
  it("s is set only when nothing usable came back", () => {
    expect(stopLookupStatus({ places: [], restaurants: failedRest })).toBe("error");
    expect(stopLookupStatus({ places: [], restaurants: { status: "skipped", restaurants: [], reason: "cache_only" } })).toBe("skipped");
    expect(stopLookupStatus({ places: [group("general", [])], restaurants: failedRest })).toBeUndefined(); // an interest answered
    expect(stopLookupStatus({ places: [], restaurants: okRestaurants([]) })).toBeUndefined();
  });
  it("stopPending: any part failed, destination and failed-geocoding stops never", () => {
    expect(stopPending({ ...CRUISE_FACTS[1], restaurants: failedRest })).toBe(true);
    expect(stopPending({ ...CRUISE_FACTS[1], places: [{ interest: "general", status: "error" }] })).toBe(true);
    expect(stopPending(CRUISE_FACTS[1])).toBe(false);
    expect(stopPending(CRUISE_FACTS[0])).toBe(false);
  });
});

describe("extendInputWithStops (upgrade of an old input, retry of failed stops)", () => {
  it("adds trip.stops, stopPlaces, stop points and index entries; the old input is not changed", () => {
    const old = emptyStored();
    const before = JSON.stringify(old);
    const next = extendInputWithStops(old, { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf(CRUISE_RESOLVED), facts: CRUISE_FACTS, lang: "de" });
    expect(JSON.stringify(old)).toBe(before);
    expect(next.llm.trip.stops).toHaveLength(5);
    expect(next.llm.stopPlaces!.map((p) => p.id)).toEqual(["s1", "s2"]);
    expect(next.stopPoints).toEqual({ s1: { lat: WIEN.lat, lon: WIEN.lon, geoId: WIEN.geoId }, s2: expect.any(Object) });
    expect(next.index.p1).toEqual(old.index.p1);
    expect(next.index.p2.stop).toBe("s1");
    expect(planInputHash(next.llm)).not.toBe(planInputHash(old.llm));
  });

  it("a retry replaces only the retried stop's entry, ids continue after the highest, old entries stay", () => {
    const first = extendInputWithStops(emptyStored(), {
      rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED),
      points: stopPointsOf(CRUISE_RESOLVED),
      facts: [CRUISE_FACTS[1], { ...CRUISE_FACTS[2], places: [], restaurants: { status: "error", restaurants: [] } }],
      lang: "de",
    });
    expect(first.llm.stopPlaces![1]).toMatchObject({ id: "s2", s: "error" });
    expect(stopsToRetry(first, [])).toEqual(["s2"]);
    expect(stopsToRetry(first, [2])).toEqual([]); // scope: day 2 is Wien
    expect(stopsToRetry(first, [3])).toEqual(["s2"]);

    const retried = extendInputWithStops(first, { facts: [CRUISE_FACTS[2]], lang: "de" });
    expect(retried.llm.stopPlaces!.map((p) => [p.id, p.s])).toEqual([["s1", undefined], ["s2", undefined]]);
    expect(retried.llm.stopPlaces![1].restaurants!.list[0].name).toBe("Weinstube");
    expect(retried.llm.stopPlaces![0]).toEqual(first.llm.stopPlaces![0]);
    expect(retried.llm.trip.stops).toEqual(first.llm.trip.stops);
    expect(retried.stopPoints).toEqual(first.stopPoints);
    expect(stopsToRetry(retried, [])).toEqual([]);
  });

  it("resolvedFromInput rebuilds the stops (id, name, point, days) for lookups", () => {
    const stored = extendInputWithStops(emptyStored(), { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf(CRUISE_RESOLVED), facts: CRUISE_FACTS, lang: "de" });
    expect(resolvedFromInput(stored)).toEqual([
      { id: "s1", name: "Wien", days: [2], role: "stop", point: { lat: WIEN.lat, lon: WIEN.lon, geoId: WIEN.geoId }, status: "ok" },
      expect.objectContaining({ id: "s2", name: "Dürnstein", days: [3], status: "ok" }),
    ]);
  });

  it("stops without a point are never retried by lookup", () => {
    const stored = storedWithStops();
    stored.llm.stopPlaces = [{ id: "s9", name: "Nirgendwo", s: "error" }];
    expect(stopsToRetry(stored, [])).toEqual([]);
  });

  it("a stop's local-cuisine filter uses the stop's country, not the destination's", () => {
    const viennese = rest(601, "Beisl", 48.209, 16.37, 0.2, ["viennese"]);
    const other = rest(602, "Tapas", 48.21, 16.37, 0.3, ["spanish"]);
    const facts = (cc?: string): StopFacts[] => [{ ...CRUISE_FACTS[1], stop: { ...CRUISE_FACTS[1].stop, ...(cc ? { countryCode: cc } : {}) }, restaurants: okRestaurants([viennese, other]) }];
    const names = (cc?: string) => stopsInput(args(facts(cc), { cuisine: { local: true }, countryCode: "DE" })).stopPlaces[0].restaurants?.list.map((r) => r.name);
    expect(names("AT")?.[0]).toBe("Beisl"); // Austrian stop on a German trip: viennese is local
    expect(names()?.[0]).not.toBe("Beisl"); // no stop country: the destination's (DE) applies
  });

  it("a failed interest group of a stop is stored in gf and makes the stop retryable", () => {
    const failedGroup: StopFacts = { ...CRUISE_FACTS[1], places: [{ interest: "family_activities", status: "error" }, group("general", [cand(103, "Stephansdom", 48.2086, 16.3731)])] };
    const stored = extendInputWithStops(emptyStored(), { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf(CRUISE_RESOLVED), facts: [failedGroup, CRUISE_FACTS[2]], lang: "de" });
    expect(stored.llm.stopPlaces![0].gf).toEqual(["family_activities"]);
    expect(stored.llm.stopPlaces![0].s).toBeUndefined();
    expect(stopsToRetry(stored, [])).toEqual(["s1"]);
    // older inputs without gf stay valid and are not retried
    delete stored.llm.stopPlaces![0].gf;
    expect(stopsToRetry(stored, [])).toEqual([]);
  });

  it("stopsToGeocode: error stops without a point, in scope, with their typed name", () => {
    const stored = storedWithStops();
    stored.llm.trip.stops = [...stored.llm.trip.stops!, { day: 6, place: "Nirgendwo", at: "s9" }];
    stored.llm.stopPlaces = [{ id: "s9", name: "Nirgendwo", s: "error" }, { id: "s8", name: "X", s: "not_found" }];
    expect(stopsToGeocode(stored, [])).toEqual([{ id: "s9", place: "Nirgendwo", day: 6 }]);
    expect(stopsToGeocode(stored, [2])).toEqual([]);
    stored.stopPoints = { ...stored.stopPoints, s9: WIEN };
    expect(stopsToGeocode(stored, [])).toEqual([]);
  });

  it("stopOk helper sanity", () => {
    expect(stopOk("s1", "Wien", [2], WIEN).keys).toEqual(["wien"]);
  });
});
