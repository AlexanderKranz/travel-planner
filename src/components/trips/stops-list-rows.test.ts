import { describe, expect, it } from "vitest";
import { stopListRows, stopTimes } from "./stops-list-rows";

describe("stopTimes", () => {
  it("joins arrival and departure", () => {
    expect(stopTimes({ arr: "07:00", dep: "18:00" })).toEqual({ kind: "range", text: "07:00–18:00" });
  });
  it("marks a departure after midnight with +1", () => {
    expect(stopTimes({ arr: "20:00", dep: "01:30" })).toEqual({ kind: "range", text: "20:00–01:30 +1" });
  });
  it("keeps a lone arrival or departure apart", () => {
    expect(stopTimes({ arr: "07:00" })).toEqual({ kind: "arr", time: "07:00" });
    expect(stopTimes({ dep: "16:00" })).toEqual({ kind: "dep", time: "16:00" });
  });
  it("is null without times", () => {
    expect(stopTimes({})).toBeNull();
  });
});

describe("stopListRows", () => {
  const stops = [
    { day: 1, place: "Passau", dep: "16:00" },
    { day: 2, sea: true as const },
    { day: 3, place: "Wien", arr: "07:00", dep: "18:00", note: "Tenderhafen" },
  ];

  it("computes the date of each trip day from the start", () => {
    expect(stopListRows(stops, "2037-12-31").map((r) => r.date)).toEqual(["2037-12-31", "2038-01-01", "2038-01-02"]);
  });

  it("has no dates for a trip without dates", () => {
    expect(stopListRows(stops, null).every((r) => r.date === null)).toBe(true);
  });

  it("maps place, sea day, times and note", () => {
    expect(stopListRows(stops, null)).toEqual([
      { day: 1, date: null, place: "Passau", sea: false, times: { kind: "dep", time: "16:00" }, note: null },
      { day: 2, date: null, place: null, sea: true, times: null, note: null },
      { day: 3, date: null, place: "Wien", sea: false, times: { kind: "range", text: "07:00–18:00" }, note: "Tenderhafen" },
    ]);
  });

  it("is empty without stops", () => {
    expect(stopListRows([], "2037-01-01")).toEqual([]);
  });
});
