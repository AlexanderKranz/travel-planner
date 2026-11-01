import { describe, expect, it } from "vitest";
import { DestinationSearchInput, DROP_REASONS, SearchDrops, SuggestionCard, SuggestionCards } from "./destination-search";

const PURPOSE = "11111111-1111-4111-8111-111111111111";

describe("DestinationSearchInput", () => {
  it("purpose only: months empty, no group, origins and limit absent (= defaults on the server)", () => {
    const p = DestinationSearchInput.parse({ purposeId: PURPOSE });
    expect(p).toEqual({ purposeId: PURPOSE, months: [], groupId: null, travelMode: "flight", saveHome: false });
    expect(p.origins).toBeUndefined();
    expect(p.maxFlightHours).toBeUndefined();
  });
  it("the purpose is required and must be a uuid", () => {
    expect(DestinationSearchInput.safeParse({}).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ purposeId: "x" }).success).toBe(false);
  });
  it("up to 3 months of 1..12", () => {
    expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE, months: [1, 2, 3] }).success).toBe(true);
    expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE, months: [1, 2, 3, 4] }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE, months: [0] }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE, months: [13] }).success).toBe(false);
  });
  it("at most 2 airports, 3 upper-case letters; empty means none", () => {
    expect(DestinationSearchInput.parse({ purposeId: PURPOSE, origins: [] }).origins).toEqual([]);
    expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE, origins: ["FRA", "MUC", "HAM"] }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE, origins: ["fra"] }).success).toBe(false);
  });
  it("flight limit: 1 to 15 h in half hours, null = none", () => {
    for (const ok of [1, 2, 2.5, 15, null]) expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE, maxFlightHours: ok }).success, String(ok)).toBe(true);
    for (const bad of [0.5, 2.3, 16, "3"]) expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE, maxFlightHours: bad }).success, String(bad)).toBe(false);
  });
  it("strips unknown fields (a client cannot send a radius or coordinates)", () => {
    const p = DestinationSearchInput.parse({ purposeId: PURPOSE, radiusKm: 99999, lat: 1 });
    expect(p).not.toHaveProperty("radiusKm");
    expect(p).not.toHaveProperty("lat");
  });
});

const card = {
  id: "g2513918",
  round: 1,
  name: "Costa del Sol",
  reason: "Viele Golfplätze",
  kind: "region",
  geoId: 2513918,
  placeName: "Marbella",
  countryCode: "ES",
  admin1: "Andalusia",
  place: { source: "geonames", fetchedAt: "2026-11-01T10:00:00.000Z", stale: false },
  flight: { origin: "FRA", gateway: "AGP", minutes: 167 },
  nearAirport: false,
  climate: {
    status: "ok",
    months: [{ month: 3, tMaxC: 18, tMinC: 9, precipMm: 50, wetDays: 5, sunshineHours: 7 }],
    period: { from: 2016, to: 2025 },
    source: "open_meteo",
    fetchedAt: "2026-11-01T10:00:00.000Z",
    stale: false,
  },
  pois: [{ status: "ok", interest: "golf", count: 6, radiusKm: 40, source: "osm", fetchedAt: "2026-11-01T10:00:00.000Z", stale: false }],
};

describe("SuggestionCard", () => {
  it("accepts the documented shape", () => {
    expect(SuggestionCard.safeParse(card).success).toBe(true);
  });
  it("a reason is optional (removed reasons are null), at most 160 characters", () => {
    expect(SuggestionCard.safeParse({ ...card, reason: null }).success).toBe(true);
    expect(SuggestionCard.safeParse({ ...card, reason: "x".repeat(161) }).success).toBe(false);
  });
  it("climate is null without months; not_checked for a provider failure", () => {
    expect(SuggestionCard.safeParse({ ...card, climate: null }).success).toBe(true);
    expect(SuggestionCard.safeParse({ ...card, climate: { status: "not_checked" } }).success).toBe(true);
  });
  it("at most 2 POI entries, ok or not_checked", () => {
    const nc = { status: "not_checked", interest: "cruise" };
    expect(SuggestionCard.safeParse({ ...card, pois: [nc, nc] }).success).toBe(true);
    expect(SuggestionCard.safeParse({ ...card, pois: [nc, nc, nc] }).success).toBe(false);
  });
  it("has no field for ages, names, prices or hours", () => {
    expect(Object.keys(SuggestionCard.shape).join(",")).not.toMatch(/age|price|hours|opening|birth/i);
  });
  it("rejects a country code that is not 2 letters and an unknown kind", () => {
    expect(SuggestionCard.safeParse({ ...card, countryCode: "ESP" }).success).toBe(false);
    expect(SuggestionCard.safeParse({ ...card, kind: "island" }).success).toBe(false);
  });
});

describe("drops", () => {
  it("counts per reason and round, no names", () => {
    expect(SearchDrops.safeParse({ "1": { not_found: 1, too_far: 3 }, "2": { climate: 2 } }).success).toBe(true);
    expect(SearchDrops.safeParse({ "1": { Marbella: 1 } }).success).toBe(false);
    expect(DROP_REASONS).toEqual(["not_found", "duplicate", "too_far", "climate", "no_poi", "geocode_failed", "no_road", "drive_failed"]);
  });
});

describe("DestinationSearchInput: flight or drive", () => {
  const drive = { purposeId: PURPOSE, travelMode: "drive", maxDriveHours: 4 };
  it("an input without travelMode is a flight search (an open old tab keeps working)", () => {
    expect(DestinationSearchInput.parse({ purposeId: PURPOSE, origins: ["FRA"], maxFlightHours: 3 })).toMatchObject({ travelMode: "flight" });
  });
  it("drive: the limit is required, 1 to 12 h in half hours", () => {
    expect(DestinationSearchInput.safeParse(drive).success).toBe(true);
    for (const ok of [1, 1.5, 12]) expect(DestinationSearchInput.safeParse({ ...drive, maxDriveHours: ok }).success, String(ok)).toBe(true);
    for (const bad of [0.5, 4.2, 13, null, "4"]) expect(DestinationSearchInput.safeParse({ ...drive, maxDriveHours: bad }).success, String(bad)).toBe(false);
    expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE, travelMode: "drive" }).success).toBe(false);
  });
  it("drive forbids airports and a flight limit, even an empty list or null", () => {
    expect(DestinationSearchInput.safeParse({ ...drive, origins: [] }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ ...drive, origins: ["FRA"] }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ ...drive, maxFlightHours: null }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ ...drive, maxFlightHours: 3 }).success).toBe(false);
  });
  it("drive accepts a start place id and saveHome", () => {
    expect(DestinationSearchInput.parse({ ...drive, homeGeoId: 2925533, saveHome: true })).toMatchObject({ homeGeoId: 2925533, saveHome: true });
    expect(DestinationSearchInput.safeParse({ ...drive, homeGeoId: 0 }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ ...drive, homeGeoId: 1.5 }).success).toBe(false);
  });
  it("flight forbids a drive limit, a start place and saveHome", () => {
    expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE, maxDriveHours: 4 }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE, homeGeoId: 5 }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE, saveHome: true }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE, travelMode: "train" }).success).toBe(false);
  });
  it("the drop reasons gain no_road and drive_failed", () => {
    expect(DROP_REASONS).toEqual(expect.arrayContaining(["no_road", "drive_failed"]));
    expect(SearchDrops.parse({ "1": { no_road: 2, drive_failed: 1 } })).toEqual({ "1": { no_road: 2, drive_failed: 1 } });
  });
});

describe("SuggestionCard.drive (optional on purpose)", () => {
  const flightCard = {
    id: "g1", round: 1, name: "Munich", reason: null, kind: "city", geoId: 1, placeName: "Munich", countryCode: "DE", admin1: null,
    place: { source: "geonames", fetchedAt: "2026-11-01T10:00:00.000Z", stale: false }, flight: null, nearAirport: false, climate: null, pois: [],
  };
  it("a saved flight card without the key still parses (a required key would empty every saved list)", () => {
    expect(SuggestionCard.safeParse(flightCard).success).toBe(true);
    expect(SuggestionCards.safeParse([flightCard, flightCard]).success).toBe(true);
  });
  it("a drive card carries minutes, km, source and date", () => {
    const drive = { min: 210, km: 392.3, source: "openrouteservice", fetchedAt: "2026-11-01T10:00:00.000Z", stale: false };
    expect(SuggestionCard.parse({ ...flightCard, drive }).drive).toEqual(drive);
    expect(SuggestionCard.safeParse({ ...flightCard, drive: null }).success).toBe(true);
    expect(SuggestionCard.safeParse({ ...flightCard, drive: { ...drive, source: "geonames" } }).success).toBe(false);
    expect(SuggestionCard.safeParse({ ...flightCard, drive: { ...drive, min: 3.5 } }).success).toBe(false);
  });
});
