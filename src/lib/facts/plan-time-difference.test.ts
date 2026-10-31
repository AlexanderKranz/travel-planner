import { describe, expect, it } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { makeT } from "@/lib/pdf/labels";
import { planTimeDifference, planTimeDifferenceText, shownTimeDifference, type PlanTimeDifference } from "./plan-time-difference";

describe("real messages", () => {
  const td: PlanTimeDifference = { kind: "ahead", hours: "6", home: null, notes: ["current"] };
  it("separates the phrase from the notes (web and pdf, de and en)", () => {
    expect(planTimeDifferenceText(td, makeT(en.plan.facts))).toBe("6 h ahead of Germany. Current value, the trip has no date yet.");
    expect(planTimeDifferenceText(td, makeT(de.pdf.facts))).toBe("6 Std. vor Deutschland. Aktueller Wert, die Reise hat noch kein Datum.");
    expect(planTimeDifferenceText({ ...td, notes: [] }, makeT(en.pdf.facts))).toBe("6 h ahead of Germany");
  });
});

describe("shownTimeDifference", () => {
  it("is only shown for the latest version", () => {
    const td: PlanTimeDifference = { kind: "ahead", hours: "6", home: null, notes: [] };
    expect(shownTimeDifference(true, td)).toBe(td);
    expect(shownTimeDifference(false, td)).toBeNull();
    expect(shownTimeDifference(true, undefined)).toBeNull();
  });
});

const tt = (key: string, v?: Record<string, string>) => `${key}${v ? JSON.stringify(v) : ""}`;
describe("planTimeDifferenceText", () => {
  it("uses the default home name when none is set and appends notes", () => {
    expect(planTimeDifferenceText({ kind: "ahead", hours: "8", home: null, notes: ["current"] }, tt)).toBe(
      'timeAhead{"diff":"8","home":"timeDefaultHome"}. timeCurrent',
    );
    expect(planTimeDifferenceText({ kind: "range", hours: "+1", to: "+2", home: "Wien", notes: ["changes"] }, tt)).toBe(
      'timeRange{"from":"+1","to":"+2","home":"Wien"}. timeChanges',
    );
  });
});

type P = Parameters<typeof planTimeDifference>[0];
const plan = (tz: string | undefined, timing: P["header"]["timing"], lengthDays = 7): P =>
  ({
    header: { timing, lengthDays },
    facts: tz ? { daylight: { timezone: tz, days: [] } } : {},
  }) as unknown as P;
const date = (startDate: string, endDate = startDate) => ({ kind: "date", startDate, endDate }) as const;
const TODAY = "2026-10-31";

describe("planTimeDifference", () => {
  it("is ahead of the default home (Germany)", () => {
    expect(planTimeDifference(plan("Asia/Bangkok", date("2026-01-10")), null, TODAY)).toEqual({
      kind: "ahead",
      hours: "6",
      home: null,
      notes: [],
    });
  });
  it("is behind the owner's home and carries its name", () => {
    const r = planTimeDifference(plan("America/New_York", date("2026-01-10")), { name: "Wien", timezone: "Europe/Vienna" }, TODAY);
    expect(r).toEqual({ kind: "behind", hours: "6", home: "Wien", notes: [] });
  });
  it("handles half hours", () => {
    expect(planTimeDifference(plan("Asia/Kolkata", date("2026-01-10")), null, TODAY)?.hours).toBe("4:30");
  });
  it("omits zero difference and a missing or invalid destination zone", () => {
    expect(planTimeDifference(plan("Europe/Paris", date("2026-01-10")), null, TODAY)).toBeNull();
    expect(planTimeDifference(plan(undefined, date("2026-01-10")), null, TODAY)).toBeNull();
    expect(planTimeDifference(plan("Mars/Olympus", date("2026-01-10")), null, TODAY)).toBeNull();
  });
  it("shows a range when daylight saving changes during the trip", () => {
    // New York switches 2026-03-08, Berlin 2026-03-29: 6 h, then 5 h, then 6 h again.
    const r = planTimeDifference(plan("America/New_York", date("2026-03-05"), 30), null, TODAY);
    expect(r).toMatchObject({ kind: "range", hours: "−6", to: "−5", notes: ["changes"] });
  });
  it("marks candidate months and undated trips", () => {
    expect(planTimeDifference(plan("America/New_York", { kind: "months", months: [3, 7] }), null, TODAY)?.notes).toContain("byMonth");
    expect(planTimeDifference(plan("Asia/Bangkok", { kind: "none" }), null, TODAY)?.notes).toEqual(["current"]);
  });
  it("falls back to the default home when the saved zone is invalid", () => {
    expect(planTimeDifference(plan("Asia/Bangkok", date("2026-01-10")), { name: "X", timezone: "Nope/Nope" }, TODAY)).toBeNull();
  });
});
