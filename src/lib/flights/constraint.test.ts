import { describe, expect, it } from "vitest";
import type { TripPurpose } from "@/lib/domain/purpose";
import { maxBlockMinutes, parseMaxFlightHours } from "./constraint";

const purpose = (o: Partial<TripPurpose> & { maxFlightHours?: number }): TripPurpose =>
  ({ id: "p", name: "x", constraints: [], guided: { maxFlightHours: o.maxFlightHours }, tags: null, createdAt: "", updatedAt: "", ...o }) as TripPurpose;

describe("max flight time", () => {
  it.each([
    ["max 3 h flight from FRA", 3],
    ["Flug höchstens 2,5 Stunden", 2.5],
    ["Flugzeit bis zu 4 Std.", 4],
    ["flight up to 2.5 hours", 2.5],
    ["we fly at most 5h", 5],
    ["max. 3 h Flug", 3],
  ])("parses %s", (s, h) => expect(parseMaxFlightHours(s)).toBe(h));

  it.each(["max 3 h drive to the hotel", "golf every day", "flight 3 h"])("ignores %s", (s) =>
    expect(parseMaxFlightHours(s)).toBeNull(),
  );

  it("reads constraints, then text; guided wins; null without purpose", () => {
    expect(maxBlockMinutes(purpose({ constraints: ["max 3 h flight from FRA"] }))).toBe(180);
    expect(maxBlockMinutes(purpose({ text: "Flug maximal 2 Stunden" }))).toBe(120);
    expect(maxBlockMinutes(purpose({ constraints: ["max 3 h flight"], maxFlightHours: 5 }))).toBe(300);
    expect(maxBlockMinutes(purpose({}))).toBeNull();
    expect(maxBlockMinutes(null)).toBeNull();
  });
});
