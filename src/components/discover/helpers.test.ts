import { describe, expect, it } from "vitest";
import { climateSummary, defaultLimitHours, dropTotals, flightHours, hasTrip, limitOptions } from "./helpers";

describe("discover helpers", () => {
  it("rounds the flight estimate to the nearest half hour, as the spec table does", () => {
    expect(flightHours(124)).toBe(2); // FRA-PMI
    expect(flightHours(167)).toBe(3); // FRA-AGP
    expect(flightHours(177)).toBe(3); // FRA-FAO
    expect(flightHours(100)).toBe(1.5);
  });

  it("takes the purpose limit onto the half-hour grid, null without one", () => {
    expect(defaultLimitHours(null)).toBeNull();
    expect(defaultLimitHours(180)).toBe(3);
    expect(defaultLimitHours(150)).toBe(2.5);
    expect(defaultLimitHours(20)).toBeNull(); // below the 1 h the API accepts
  });

  it("keeps an unusual limit selectable", () => {
    expect(limitOptions(null)).toContain(3);
    expect(limitOptions(9)).toContain(9);
    expect(limitOptions(9, null)).toEqual([...limitOptions(9)].sort((a, b) => a - b));
  });

  it("averages the chosen months", () => {
    expect(climateSummary([])).toBeNull();
    expect(climateSummary([{ tMaxC: 18, tMinC: 8, wetDays: 6 }, { tMaxC: 20, tMinC: 10, wetDays: 4 }])).toEqual({ high: 19, low: 9, wet: 5 });
  });

  it("adds the drop counts of both rounds and leaves out zeros", () => {
    expect(dropTotals({})).toEqual([]);
    expect(dropTotals({ "1": { too_far: 2, climate: 1 }, "2": { too_far: 3, no_poi: 0 } })).toEqual([
      ["too_far", 5],
      ["climate", 1],
    ]);
  });

  it("finds the trip made from a card by geoId", () => {
    expect(hasTrip({ geoId: 7 }, { "7": "t1" })).toBe("t1");
    expect(hasTrip({ geoId: 8 }, { "7": "t1" })).toBeNull();
  });
});
