import { describe, expect, it } from "vitest";
import { DestinationSearchInput, DROP_REASONS, SearchDrops, SuggestionCard } from "./destination-search";

const PURPOSE = "11111111-1111-4111-8111-111111111111";

describe("DestinationSearchInput", () => {
  it("purpose only: months empty, no group, origins and limit absent (= defaults on the server)", () => {
    const p = DestinationSearchInput.parse({ purposeId: PURPOSE });
    expect(p).toEqual({ purposeId: PURPOSE, months: [], groupId: null });
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
    expect(DROP_REASONS).toEqual(["not_found", "duplicate", "too_far", "climate", "no_poi", "geocode_failed"]);
  });
});
