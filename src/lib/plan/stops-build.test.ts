import { describe, expect, it, vi } from "vitest";
import type { TripFacts } from "@/lib/domain/facts";
import type { Trip } from "@/lib/domain/trip";
import { ownAgeRefs } from "@/lib/group";
import { canonicalJson } from "./hash";
import { buildPlanInput, type DriveInput } from "./input";
import { CRUISE_FACTS, CRUISE_STOPS, T, cand, group, okRestaurants } from "./stops-test-helpers";

vi.mock("server-only", () => ({}));

const trip: Trip = {
  id: "t1",
  ownerId: "u1",
  access: "owner",
  destination: { kind: "region", name: "Donau", placeName: "Passau", geoId: 1, countryCode: "DE", admin1: null, lat: 48.5665, lon: 13.43122, timezone: "Europe/Berlin", radiusKm: 15 },
  lengthDays: 5,
  timing: { kind: "date", startDate: "2037-12-19" },
  groupId: null,
  purposeId: null,
  wantsFlights: false,
  originAirports: [],
  notes: "Schiff, feste Hafenzeiten",
  createdAt: T,
  updatedAt: T,
};

const baseFacts: TripFacts = {
  tripId: "t1",
  generatedAt: T,
  referenceDates: [],
  weather: { status: "unavailable", reason: "not_found" },
  daylight: { status: "unavailable", reason: "not_found" },
  country: { status: "unavailable", reason: "not_found" },
  summary: { status: "unavailable", reason: "not_found" },
  places: {
    status: "ok",
    data: { radiusKm: 15, groups: [group("general", [cand(1, "Passauer Dom", 48.5665, 13.4312, "tourism=attraction", 0.5)])], customInterests: [] },
    source: "osm",
    fetchedAt: T,
    stale: false,
  },
  restaurants: okRestaurants([]),
};

const build = (over: Partial<Parameters<typeof buildPlanInput>[0]> = {}) =>
  buildPlanInput({ trip, group: null, purpose: null, ageRefs: ownAgeRefs("1980-05-01"), facts: baseFacts, locale: "de", today: "2026-11-11", ...over });

describe("buildPlanInput with trip stops (plan-8)", () => {
  it("a trip without stops has exactly the input it had before: no trip.stops, no stopPlaces, no stopPoints", () => {
    const plain = build();
    expect(canonicalJson(build({ stops: [] }).stored)).toBe(canonicalJson(plain.stored));
    expect(plain.stored.llm.trip).not.toHaveProperty("stops");
    expect(plain.stored.llm).not.toHaveProperty("stopPlaces");
    expect(plain.stored).not.toHaveProperty("stopPoints");
  });

  it("stops without lookups (facts.stops absent) still send the schedule rows, without `at`", () => {
    const { stored } = build({ stops: CRUISE_STOPS });
    expect(stored.llm.trip.stops).toHaveLength(5);
    expect(stored.llm.trip.stops!.every((r) => !("at" in r))).toBe(true);
    expect(stored.llm).not.toHaveProperty("stopPlaces");
  });

  it("sends the schedule with `at`, the verified places per stop, and stores the stop points beside the input", () => {
    const { stored } = build({ stops: CRUISE_STOPS, facts: { ...baseFacts, stops: CRUISE_FACTS } });
    expect(stored.llm.trip.stops!.map((r) => r.at)).toEqual(["dest", "s1", "s2", undefined, "dest"]);
    expect(stored.llm.stopPlaces!.map((p) => p.id)).toEqual(["s1", "s2"]);
    // the destination keeps p1; stop places continue after it
    expect(stored.llm.places.map((p) => p.id)).toEqual(["p1"]);
    expect(stored.llm.stopPlaces![0].places![0].id).toBe("p2");
    expect(stored.stopPoints).toEqual({ s1: expect.any(Object), s2: expect.any(Object) });
    expect(stored.index.p2.stop).toBe("s1");
    expect(stored.index.p1.stop).toBeUndefined();
    // the stop point is not part of what the model sees (and so not of the hash)
    expect(canonicalJson(stored.llm)).not.toContain("geoId");
  });

  it("drive times from a stop reach the stop's places with `from` = the stop name", () => {
    const stopDrive: Record<string, DriveInput> = { s1: { byKey: { "node/101": { min: 14, km: 11 } }, fetchedAt: T } };
    const { stored } = build({ stops: CRUISE_STOPS, facts: { ...baseFacts, stops: CRUISE_FACTS }, stopDrive });
    expect(stored.index.p2.place.drive).toMatchObject({ min: 14, km: 11, from: "Wien" });
  });

  it("the destination's drive times carry no `from`", () => {
    const drive: DriveInput = { byKey: { "node/1": { min: 3, km: 1.2 } }, fetchedAt: T };
    const { stored } = build({ drive });
    expect(stored.index.p1.place.drive).toEqual({ min: 3, km: 1.2, source: "openrouteservice", fetchedAt: T });
  });
});
