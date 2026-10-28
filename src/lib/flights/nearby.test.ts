import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeFids } from "@/lib/integrations/aerodatabox-normalize";
import { flightLinks } from "./links";
import { flightDates } from "./lookups";
import { NEARBY_UNIT_CAP, buildNearbyDays, nearbyTargets } from "./nearby";

const TODAY = "2026-10-28";
const fx = (n: string) => JSON.parse(readFileSync(`${__dirname}/../integrations/__fixtures__/aerodatabox/${n}`, "utf8"));
const fra = normalizeFids(fx("fids-departures-FRA-2027-03-06.json"));
const dates = (start: string, len = 5) => flightDates({ timing: { kind: "date", startDate: start }, lengthDays: len }, TODAY)!;

describe("nearbyTargets", () => {
  it("schedule mode: day before and after the trip date, back direction uses the return date", () => {
    const d = dates("2027-03-13", 5);
    expect(nearbyTargets(d, "out", TODAY)).toEqual({
      mode: "schedule",
      targets: [
        { offset: -1, date: "2027-03-12", checked: "2027-03-12" },
        { offset: 1, date: "2027-03-14", checked: "2027-03-14" },
      ],
    });
    expect(nearbyTargets(d, "back", TODAY)!.targets.map((t) => t.date)).toEqual(["2027-03-16", "2027-03-18"]);
  });
  it("costs at most one airport x two days x two windows", () => {
    expect(NEARBY_UNIT_CAP).toBe(2 * 2 * 2);
  });
  it("sample week (months) offers nothing", () => {
    const d = flightDates({ timing: { kind: "months", months: [3] }, lengthDays: 5 }, TODAY)!;
    expect(nearbyTargets(d, "out", TODAY)).toBeNull();
  });
  it("proxy mode shifts the proxy date by the same offset but keeps the real dates", () => {
    const d = dates("2038-03-13");
    const r = nearbyTargets(d, "out", TODAY)!;
    expect(r.mode).toBe("proxy");
    expect(r.targets.map((t) => t.date)).toEqual(["2038-03-12", "2038-03-14"]);
    expect(r.targets.map((t) => t.checked)).toEqual(["2026-03-13", "2026-03-15"]); // proxy 2026-03-14 (Sat) +-1
  });
  it("does not check days beyond the 360-day horizon or in the past", () => {
    // 2027-10-23 is exactly 360 days after 2026-10-28
    const edge = nearbyTargets(dates("2027-10-23"), "out", TODAY)!;
    expect(edge.targets).toEqual([
      { offset: -1, date: "2027-10-22", checked: "2027-10-22" },
      { offset: 1, date: "2027-10-24", checked: null },
    ]);
    const past = nearbyTargets(dates("2026-10-28"), "out", TODAY)!;
    expect(past.targets[0]).toEqual({ offset: -1, date: "2026-10-27", checked: null });
    expect(past.targets[1].checked).toBe("2026-10-29");
  });
});

describe("buildNearbyDays", () => {
  const plan = nearbyTargets(dates("2027-03-07"), "out", TODAY)!; // day before = 2027-03-06 = recorded fixture day
  const mk = (lookups: Parameters<typeof buildNearbyDays>[0]["lookups"], maxBlockMin: number | null = null) =>
    buildNearbyDays({ dir: "out", depart: "FRA", arrive: "AGP", targets: plan.targets, lookups, maxBlockMin });

  it("groups by date with weekday, dedupes codeshares and sorts by departure time", () => {
    const days = mk({ "2027-03-06": { data: fra, complete: true }, "2027-03-08": { data: [], complete: true } });
    expect(days.map((d) => [d.date, d.weekday, d.checked])).toEqual([["2027-03-06", 6, true], ["2027-03-08", 1, true]]);
    expect(days[0].legs.map((l) => l.number)).toContain("LH 1148");
    expect(new Set(days[0].legs.map((l) => l.dep)).size).toBe(days[0].legs.length); // one leg per departure time
    const deps = days[0].legs.map((l) => l.dep);
    expect(deps).toEqual([...deps].sort());
    expect(days[0].legs.every((l) => l.date === "2027-03-06" && l.from === "FRA" && l.to === "AGP")).toBe(true);
    expect(days[1]).toMatchObject({ legs: [], complete: true, checked: true });
  });
  it("marks unchecked and partial days", () => {
    const days = mk({ "2027-03-06": { data: fra, complete: false } });
    expect(days[0]).toMatchObject({ checked: true, complete: false });
    expect(days[1]).toMatchObject({ checked: false, complete: false, legs: [] });
  });
  it("flags legs over the flight-time limit", () => {
    const days = mk({ "2027-03-06": { data: fra, complete: true } }, 1);
    expect(days[0].legs.every((l) => l.tooLong)).toBe(true);
  });
  it("booking links use the nearby date for that leg only", () => {
    const l = flightLinks({ from: "FRA", to: "AGP", out: "2027-03-06", back: "2027-03-11", adults: 2, locale: "en" });
    expect(l.skyscanner).toContain("/270306/270311/");
  });
});
