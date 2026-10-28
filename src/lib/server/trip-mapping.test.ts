import { describe, expect, it } from "vitest";
import { TripInput } from "@/lib/domain/trip";
import type { GeoPlace } from "@/lib/domain/geo";
import { buildTripWrite, factsInputsChanged, rowToTrip, type TripRow } from "./trip-mapping";

const place: GeoPlace = {
  geoId: 2513918,
  name: "Marbella",
  featureCode: "PPLA3",
  countryCode: "ES",
  admin1: "Andalusia",
  lat: 36.51,
  lon: -4.88,
  timezone: "Europe/Madrid",
  population: 140000,
  suggestedKind: "city",
};

describe("buildTripWrite", () => {
  it("destination + length only: everything else defaults", () => {
    const input = TripInput.parse({ destination: { kind: "freetext", name: "Irgendwo" }, lengthDays: 3 });
    const w = buildTripWrite(input, null);
    expect(w).toMatchObject({
      dest_kind: "freetext",
      dest_name: "Irgendwo",
      dest_lat: null,
      dest_geo_id: null,
      dest_radius_km: null,
      start_date: null,
      months: [],
      group_id: null,
      wants_flights: true,
      origin_airports: [],
      title: null,
      notes: null,
    });
  });

  it("geocoded: coordinates come from the place lookup, name defaults to the place", () => {
    const input = TripInput.parse({ destination: { kind: "city", geoId: 2513918 }, lengthDays: 5 });
    const w = buildTripWrite(input, place);
    expect(w).toMatchObject({
      dest_name: "Marbella",
      dest_place_name: "Marbella",
      dest_geo_id: 2513918,
      dest_lat: 36.51,
      dest_lon: -4.88,
      dest_country_code: "ES",
      dest_timezone: "Europe/Madrid",
      dest_radius_km: null,
    });
  });

  it("region with custom name and radius; months timing", () => {
    const input = TripInput.parse({
      destination: { kind: "region", geoId: 2513918, name: "Costa del Sol", radiusKm: 40 },
      lengthDays: 5,
      timing: { kind: "months", months: [4, 3, 3] },
    });
    const w = buildTripWrite(input, place);
    expect(w).toMatchObject({ dest_name: "Costa del Sol", dest_place_name: "Marbella", dest_radius_km: 40, months: [3, 4], start_date: null });
  });

  it("date timing clears months; freetext keeps its optional country", () => {
    const input = TripInput.parse({
      destination: { kind: "freetext", name: "Alpen", countryCode: "AT" },
      lengthDays: 2,
      timing: { kind: "date", startDate: "2027-01-05" },
    });
    expect(buildTripWrite(input, place)).toMatchObject({
      start_date: "2027-01-05",
      months: [],
      dest_country_code: "AT",
      dest_lat: null,
    });
  });
});

const row: TripRow = {
  id: "t1",
  title: null,
  dest_kind: "region",
  dest_name: "Costa del Sol",
  dest_place_name: "Marbella",
  dest_geo_id: 2513918,
  dest_country_code: "ES",
  dest_admin1: null,
  dest_lat: 36.51,
  dest_lon: -4.88,
  dest_timezone: "Europe/Madrid",
  dest_radius_km: null,
  length_days: 5,
  start_date: null,
  months: [3],
  group_id: null,
  purpose_id: null,
  wants_flights: true,
  origin_airports: [],
  notes: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("rowToTrip", () => {
  it("applies the default radius by kind and derives timing", () => {
    const t = rowToTrip(row);
    expect(t.destination).toMatchObject({ kind: "region", radiusKm: 40, placeName: "Marbella" });
    expect(t.timing).toEqual({ kind: "months", months: [3] });
    expect(t.title).toBeUndefined();
    expect(rowToTrip({ ...row, dest_kind: "city" }).destination).toMatchObject({ radiusKm: 15 });
    expect(rowToTrip({ ...row, months: [], start_date: "2027-03-01" }).timing).toEqual({ kind: "date", startDate: "2027-03-01" });
    expect(rowToTrip({ ...row, months: [] }).timing).toEqual({ kind: "none" });
  });
});

describe("factsInputsChanged", () => {
  const write = buildTripWrite(
    TripInput.parse({
      destination: { kind: "region", geoId: 2513918, name: "Costa del Sol" },
      lengthDays: 5,
      timing: { kind: "months", months: [3] },
    }),
    place,
  );
  it("is false for title/notes/group edits and true for destination, timing, purpose", () => {
    expect(factsInputsChanged(row, { ...write, title: "x", notes: "y", group_id: "g" })).toBe(false);
    expect(factsInputsChanged(row, { ...write, dest_geo_id: 1 })).toBe(true);
    expect(factsInputsChanged(row, { ...write, months: [4] })).toBe(true);
    expect(factsInputsChanged(row, { ...write, purpose_id: "p" })).toBe(true);
  });
});
