import { describe, expect, it } from "vitest";
import { GroupEntry, TravelGroupInput } from "./group";
import { IsoDate } from "./common";
import { hasHomeCoords, Profile, ProfileUpdate } from "./profile";
import { TripPurposeInput } from "./purpose";

describe("IsoDate", () => {
  it("accepts real dates only", () => {
    expect(IsoDate.safeParse("2028-02-29").success).toBe(true);
    expect(IsoDate.safeParse("2027-02-29").success).toBe(false);
    expect(IsoDate.safeParse("2027-2-9").success).toBe(false);
  });
});

describe("ProfileUpdate", () => {
  it("accepts partial updates", () => {
    expect(ProfileUpdate.parse({ locale: "en" })).toEqual({ locale: "en" });
  });
  it("limits home airports to 5 unique IATA codes", () => {
    expect(ProfileUpdate.safeParse({ homeAirports: ["FRA", "MUC"] }).success).toBe(true);
    const home = { homeLocation: "Wien, Österreich", homeTimezone: "Europe/Vienna" };
    expect(ProfileUpdate.safeParse(home).success).toBe(true);
    expect(ProfileUpdate.safeParse({ homeLocation: null, homeTimezone: null }).success).toBe(true);
    expect(ProfileUpdate.safeParse({ ...home, homeTimezone: "Mars/Base" }).success).toBe(false);
    expect(ProfileUpdate.safeParse({ ...home, homeTimezone: null }).success).toBe(false);
    expect(ProfileUpdate.safeParse({ homeLocation: "Wien" }).success).toBe(false);
    expect(ProfileUpdate.safeParse({ homeAirports: ["fra"] }).success).toBe(false);
    expect(ProfileUpdate.safeParse({ homeAirports: ["FRA", "FRA"] }).success).toBe(false);
    expect(ProfileUpdate.safeParse({ homeAirports: ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"] }).success).toBe(false);
  });
  it("rejects unsupported locales and future birthdates", () => {
    expect(ProfileUpdate.safeParse({ locale: "fr" }).success).toBe(false);
    expect(ProfileUpdate.safeParse({ birthdate: "2999-01-01" }).success).toBe(false);
    expect(ProfileUpdate.safeParse({ birthdate: null }).success).toBe(true);
  });
});

describe("Profile", () => {
  it("reads a stored home zone it does not know, so one bad row cannot break every page", () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000001",
      role: "user",
      displayName: null,
      locale: "de",
      homeAirports: [],
      birthdate: null,
      isDemo: false,
      onboardingDoneAt: null,
      homeLocation: "Mars",
      homeTimezone: "Mars/Base",
      homeGeoId: null,
      homeLat: null,
      homeLon: null,
    };
    expect(Profile.safeParse(row).success).toBe(true);
  });
});

describe("ProfileUpdate home place id", () => {
  it("a place id goes with a home name and zone; null clears", () => {
    expect(ProfileUpdate.safeParse({ homeLocation: "Frankfurt", homeTimezone: "Europe/Berlin", homeGeoId: 2925533 }).success).toBe(true);
    expect(ProfileUpdate.safeParse({ homeLocation: null, homeTimezone: null, homeGeoId: null }).success).toBe(true);
    expect(ProfileUpdate.safeParse({ homeLocation: "Frankfurt", homeTimezone: "Europe/Berlin" }).success).toBe(true); // legacy: no id
  });
  it("a place id without a home is refused, and so are bad ids; coordinates are never accepted from the browser", () => {
    expect(ProfileUpdate.safeParse({ homeLocation: null, homeTimezone: null, homeGeoId: 5 }).success).toBe(false);
    expect(ProfileUpdate.safeParse({ homeLocation: "X", homeTimezone: "Europe/Berlin", homeGeoId: 0 }).success).toBe(false);
    const parsed = ProfileUpdate.parse({ homeLocation: "X", homeTimezone: "Europe/Berlin", homeGeoId: 5, homeLat: 1, homeLon: 2 });
    expect(parsed).not.toHaveProperty("homeLat");
    expect(parsed).not.toHaveProperty("homeLon");
  });
  it("hasHomeCoords needs all four", () => {
    const home = { homeLocation: "F", homeGeoId: 1, homeLat: 50, homeLon: 8 };
    expect(hasHomeCoords(home)).toBe(true);
    expect(hasHomeCoords({ ...home, homeLat: null })).toBe(false);
    expect(hasHomeCoords({ ...home, homeGeoId: null })).toBe(false);
    expect(hasHomeCoords({ ...home, homeLocation: null })).toBe(false);
  });
});

describe("GroupEntry", () => {
  it("accepts a composition without any age", () => {
    expect(GroupEntry.safeParse({ kind: "composition", count: 2 }).success).toBe(true);
  });
  it("accepts the Danube toddler entry", () => {
    const r = GroupEntry.safeParse({
      kind: "composition",
      count: 1,
      label: "Kleinkind",
      age: { ageMode: "approx", age: 1 },
      traits: { needsNap: true },
    });
    expect(r.success).toBe(true);
  });
  it("requires a name unless the member is self", () => {
    expect(GroupEntry.safeParse({ kind: "member" }).success).toBe(false);
    expect(GroupEntry.safeParse({ kind: "member", isSelf: true }).success).toBe(true);
    expect(GroupEntry.safeParse({ kind: "member", isSelf: true, name: "Me" }).success).toBe(false);
  });
  it("rejects birthdate together with a stated age", () => {
    const r = GroupEntry.safeParse({
      kind: "member",
      name: "Ben",
      birthdate: "2015-01-01",
      age: { ageMode: "exact", age: 11 },
    });
    expect(r.success).toBe(false);
  });
  it("requires an age for exact/approx and rejects unknown traits", () => {
    expect(GroupEntry.safeParse({ kind: "composition", count: 1, age: { ageMode: "exact" } }).success).toBe(false);
    expect(GroupEntry.safeParse({ kind: "composition", count: 1, traits: { foo: 1 } }).success).toBe(false);
  });
  it("rejects count out of range", () => {
    expect(GroupEntry.safeParse({ kind: "composition", count: 0 }).success).toBe(false);
    expect(GroupEntry.safeParse({ kind: "composition", count: 51 }).success).toBe(false);
  });
});

describe("TravelGroupInput", () => {
  it("allows a group with only a name", () => {
    expect(TravelGroupInput.parse({ name: "Familie" }).entries).toEqual([]);
  });
  it("rejects two self entries and empty names", () => {
    const self = { kind: "member", isSelf: true };
    expect(TravelGroupInput.safeParse({ name: "X", entries: [self, self] }).success).toBe(false);
    expect(TravelGroupInput.safeParse({ name: "  " }).success).toBe(false);
  });
});

describe("TripPurposeInput", () => {
  it("needs only a name", () => {
    expect(TripPurposeInput.parse({ name: "Golftrip" })).toMatchObject({ guided: {}, constraints: [] });
  });
  it("validates guided answers and constraints", () => {
    expect(TripPurposeInput.safeParse({ name: "x", guided: { pace: "fast" } }).success).toBe(false);
    expect(TripPurposeInput.safeParse({ name: "x", guided: { v: 1, pace: "relaxed", rooms: "single_rooms" } }).success).toBe(true);
    expect(TripPurposeInput.safeParse({ name: "x", constraints: [""] }).success).toBe(false);
    expect(TripPurposeInput.safeParse({ name: "x", constraints: Array(31).fill("a") }).success).toBe(false);
  });
});

describe("TravelGroupInput traitKeys", () => {
  it("defaults to [] and drops duplicates keeping order", () => {
    expect(TravelGroupInput.parse({ name: "g" }).traitKeys).toEqual([]);
    expect(TravelGroupInput.parse({ name: "g", traitKeys: ["diet", "mobility", "diet"] }).traitKeys).toEqual([
      "diet",
      "mobility",
    ]);
  });
  it("rejects unknown keys", () => {
    expect(TravelGroupInput.safeParse({ name: "g", traitKeys: ["bogus"] }).success).toBe(false);
  });
});
