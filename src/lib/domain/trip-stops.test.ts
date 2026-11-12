import { describe, expect, it } from "vitest";
import { TripInput } from "./trip";
import {
  dayOfDate,
  fitStopsToTrip,
  parseStoredStops,
  sameStops,
  sortStops,
  stopDate,
  stopsByDay,
  stopsOutsideTrip,
  tripStops,
  TripStop,
  TripStops,
  type TripStop as Stop,
} from "./trip-stops";

// Synthetic schedule (made-up ports and times).
const schedule: Stop[] = [
  { day: 1, place: "Hafenstadt", dep: "16:00" },
  { day: 2, place: "Altstadt", arr: "14:00", dep: "23:59" },
  { day: 3, place: "Weinort", arr: "07:00", dep: "12:00" },
  { day: 3, place: "Klosterort", arr: "15:00", dep: "21:00" },
  { day: 4, sea: true },
];

describe("TripStop", () => {
  it("accepts a port with times, a sea day and a country hint", () => {
    expect(TripStop.safeParse({ day: 2, place: " Altstadt ", cc: "AT", arr: "14:00", dep: "23:59" }).success).toBe(true);
    expect(TripStop.safeParse({ day: 4, sea: true }).success).toBe(true);
    expect(TripStop.parse({ day: 1, place: " Hafen " }).place).toBe("Hafen");
  });

  it("requires place xor sea", () => {
    expect(TripStop.safeParse({ day: 1 }).success).toBe(false);
    expect(TripStop.safeParse({ day: 1, place: "X", sea: true }).success).toBe(false);
    expect(TripStop.safeParse({ day: 1, place: "   " }).success).toBe(false);
    expect(TripStop.safeParse({ day: 1, sea: false }).success).toBe(false);
  });

  it("checks day, times, country code and lengths", () => {
    expect(TripStop.safeParse({ day: 0, place: "X" }).success).toBe(false);
    expect(TripStop.safeParse({ day: 61, place: "X" }).success).toBe(false);
    expect(TripStop.safeParse({ day: 1.5, place: "X" }).success).toBe(false);
    expect(TripStop.safeParse({ day: 1, place: "X", arr: "24:00" }).success).toBe(false);
    expect(TripStop.safeParse({ day: 1, place: "X", arr: "7:00" }).success).toBe(false);
    expect(TripStop.safeParse({ day: 1, place: "X", cc: "at" }).success).toBe(false);
    expect(TripStop.safeParse({ day: 1, place: "x".repeat(81) }).success).toBe(false);
    expect(TripStop.safeParse({ day: 1, place: "x".repeat(80), note: "n".repeat(61) }).success).toBe(false);
  });
});

describe("TripStops", () => {
  it("sorts by day, then arr ?? dep", () => {
    const parsed = TripStops.parse([
      { day: 3, place: "Klosterort", arr: "15:00" },
      { day: 3, place: "Weinort", arr: "07:00" },
      { day: 1, place: "Hafenstadt", dep: "16:00" },
    ]);
    expect(parsed.map((s) => s.place)).toEqual(["Hafenstadt", "Weinort", "Klosterort"]);
  });

  it("allows 40 stops and refuses 41", () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ day: (i % 10) + 1, place: `Ort ${i}` }));
    expect(TripStops.safeParse(make(40)).success).toBe(true);
    expect(TripStops.safeParse(make(41)).success).toBe(false);
  });
});

describe("sortStops", () => {
  it("is stable for equal keys and does not mutate", () => {
    const input: Stop[] = [
      { day: 2, place: "B" },
      { day: 2, place: "A" },
      { day: 1, place: "C" },
    ];
    expect(sortStops(input).map((s) => s.place)).toEqual(["C", "B", "A"]);
    expect(input[0].place).toBe("B");
  });
});

describe("day and date mapping", () => {
  it("maps both ways, across month and year ends", () => {
    expect(stopDate("2037-12-19", 1)).toBe("2037-12-19");
    expect(stopDate("2037-12-19", 5)).toBe("2037-12-23");
    expect(stopDate("2037-12-30", 4)).toBe("2038-01-02");
    expect(dayOfDate("2037-12-19", "2037-12-23")).toBe(5);
    expect(dayOfDate("2037-12-30", "2038-01-02")).toBe(4);
    expect(dayOfDate("2037-12-19", "2037-12-18")).toBe(0);
  });

  it("is not thrown off by a daylight saving change", () => {
    expect(stopDate("2037-03-27", 3)).toBe("2037-03-29");
    expect(dayOfDate("2037-03-27", "2037-03-30")).toBe(4);
  });
});

describe("trip length helpers", () => {
  it("finds and drops stops after the last day", () => {
    expect(stopsOutsideTrip(schedule, 3).map((s) => s.day)).toEqual([4]);
    expect(fitStopsToTrip(schedule, 3)).toHaveLength(4);
    expect(stopsOutsideTrip(schedule, 5)).toEqual([]);
  });

  it("groups by day", () => {
    const byDay = stopsByDay(schedule);
    expect([...byDay.keys()]).toEqual([1, 2, 3, 4]);
    expect(byDay.get(3)).toHaveLength(2);
  });
});

describe("TripInput.stops", () => {
  const base = { destination: { kind: "freetext" as const, name: "Irgendwo" }, lengthDays: 3 };

  it("is optional, so a trip without stops is unchanged", () => {
    const parsed = TripInput.parse(base);
    expect(parsed.stops).toBeUndefined();
  });

  it("accepts stops inside the trip and refuses stops after the last day", () => {
    expect(TripInput.safeParse({ ...base, stops: schedule.slice(0, 4) }).success).toBe(true);
    const bad = TripInput.safeParse({ ...base, stops: schedule });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].path).toEqual(["stops"]);
  });
});

describe("stored stops", () => {
  it("parseStoredStops tolerates null and corrupt values", () => {
    expect(parseStoredStops(null)).toEqual([]);
    expect(parseStoredStops("x")).toEqual([]);
    expect(parseStoredStops([{ day: 1 }])).toEqual([]);
    expect(parseStoredStops([{ day: 1, place: "Hafen" }])).toEqual([{ day: 1, place: "Hafen" }]);
  });

  it("sameStops compares values", () => {
    expect(sameStops(null, [])).toBe(true);
    expect(sameStops(schedule, [...schedule])).toBe(true);
    expect(sameStops(schedule, schedule.slice(1))).toBe(false);
  });
});

describe("tripStops resolution [D10]", () => {
  const trip = { lengthDays: 5, notes: "Tag 1 Hafenstadt" as string | undefined };
  const derived = { notes: "Tag 1 Hafenstadt", stops: [{ day: 1, place: "Aus Notizen" }] };

  it("confirmed stops win over derived ones", () => {
    const got = tripStops({ ...trip, stops: [{ day: 2, place: "Bestätigt" }] }, derived);
    expect(got).toEqual([{ day: 2, place: "Bestätigt" }]);
  });

  it("uses derived stops when nothing is confirmed (undefined or empty)", () => {
    expect(tripStops({ ...trip }, derived)).toEqual([{ day: 1, place: "Aus Notizen" }]);
    expect(tripStops({ ...trip, stops: [] }, derived)).toEqual([{ day: 1, place: "Aus Notizen" }]);
  });

  it("returns none without confirmed or derived stops", () => {
    expect(tripStops({ ...trip })).toEqual([]);
    expect(tripStops({ ...trip }, null)).toEqual([]);
  });

  it("ignores a derived result made for other notes", () => {
    expect(tripStops({ ...trip, notes: "geändert" }, derived)).toEqual([]);
    expect(tripStops({ ...trip, notes: undefined }, derived)).toEqual([]);
  });

  it("drops derived stops outside the trip, keeps confirmed ones as saved, and sorts", () => {
    const d = { notes: "n", stops: [{ day: 4, place: "Spät" }, { day: 6, place: "Zu spät" }, { day: 2, place: "Früh" }] };
    expect(tripStops({ lengthDays: 5, notes: "n" }, d).map((s) => s.place)).toEqual(["Früh", "Spät"]);
    expect(tripStops({ lengthDays: 3, stops: [{ day: 5, place: "Gespeichert" }] }).map((s) => s.place)).toEqual(["Gespeichert"]);
  });
});
