import { describe, expect, it } from "vitest";
import { DestinationInput, TripInput, TripTimingInput } from "./trip";

const city = { kind: "city", geoId: 2855328 } as const;

describe("TripTimingInput", () => {
  it("accepts the three variants", () => {
    expect(TripTimingInput.safeParse({ kind: "date", startDate: "2026-12-01" }).success).toBe(true);
    expect(TripTimingInput.safeParse({ kind: "none" }).success).toBe(true);
    const m = TripTimingInput.parse({ kind: "months", months: [12, 3, 3] });
    expect(m).toEqual({ kind: "months", months: [3, 12] });
  });
  it("rejects bad input", () => {
    expect(TripTimingInput.safeParse({ kind: "date", startDate: "2026-02-31" }).success).toBe(false);
    expect(TripTimingInput.safeParse({ kind: "months", months: [] }).success).toBe(false);
    expect(TripTimingInput.safeParse({ kind: "months", months: [13] }).success).toBe(false);
    expect(TripTimingInput.safeParse({ kind: "date", startDate: "2026-12-01", months: [1] }).success).toBe(true); // extra key stripped
    expect(TripTimingInput.safeParse({ kind: "other" }).success).toBe(false);
  });
});

describe("DestinationInput", () => {
  it("accepts city, region and freetext", () => {
    expect(DestinationInput.safeParse(city).success).toBe(true);
    expect(DestinationInput.safeParse({ kind: "region", geoId: 1, radiusKm: 40, name: " Costa del Sol " }).success).toBe(true);
    expect(DestinationInput.safeParse({ kind: "freetext", name: "Donau" }).success).toBe(true);
    expect(DestinationInput.safeParse({ kind: "freetext", name: "Donau", countryCode: "DE" }).success).toBe(true);
  });
  it("rejects invalid variants", () => {
    expect(DestinationInput.safeParse({ kind: "city" }).success).toBe(false);
    expect(DestinationInput.safeParse({ kind: "city", geoId: 0 }).success).toBe(false);
    expect(DestinationInput.safeParse({ kind: "region", geoId: 1, radiusKm: 201 }).success).toBe(false);
    expect(DestinationInput.safeParse({ kind: "freetext", name: "  " }).success).toBe(false);
    expect(DestinationInput.safeParse({ kind: "freetext", name: "x", countryCode: "de" }).success).toBe(false);
  });
});

describe("TripInput", () => {
  it("accepts destination and length only, applying defaults", () => {
    const t = TripInput.parse({ destination: city, lengthDays: 7 });
    expect(t.timing).toEqual({ kind: "none" });
    expect(t.groupId).toBeNull();
    expect(t.wantsFlights).toBe(false);
    expect(t.originAirports).toEqual([]);
  });
  it("enforces length bounds", () => {
    expect(TripInput.safeParse({ destination: city, lengthDays: 0 }).success).toBe(false);
    expect(TripInput.safeParse({ destination: city, lengthDays: 1 }).success).toBe(true);
    expect(TripInput.safeParse({ destination: city, lengthDays: 60 }).success).toBe(true);
    expect(TripInput.safeParse({ destination: city, lengthDays: 61 }).success).toBe(false);
  });
  it("validates airports", () => {
    expect(TripInput.safeParse({ destination: city, lengthDays: 3, originAirports: ["MUC"] }).success).toBe(true);
    expect(TripInput.safeParse({ destination: city, lengthDays: 3, originAirports: ["muc"] }).success).toBe(false);
  });
});
