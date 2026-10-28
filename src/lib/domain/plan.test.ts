import { describe, expect, it } from "vitest";
import golf from "@/lib/plan/__fixtures__/plan-golf.json";
import cruise from "@/lib/plan/__fixtures__/plan-cruise.json";
import stateEmpty from "@/lib/plan/__fixtures__/plan-state-empty.json";
import stateBusy from "@/lib/plan/__fixtures__/plan-state-busy.json";
import stateOutdated from "@/lib/plan/__fixtures__/plan-state-outdated.json";
import { isPlanOutdated, Plan, PlanEdit, PlanFeedback } from "./plan";

const clone = <T>(v: T): T => structuredClone(v);

describe("Plan fixtures", () => {
  it.each([
    ["golf", golf],
    ["cruise", cruise],
  ])("%s parses, has 5 days, one best day and only known refs", (_, fixture) => {
    const plan = Plan.parse(fixture);
    expect(plan.days.map((d) => d.n)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.days.filter((d) => d.best)).toHaveLength(1);
    const refs = plan.days.flatMap((d) => d.stops.flatMap((s) => s.acts.flatMap((a) => (a.ref ? [a.ref] : []))));
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(plan.places[r]).toBeDefined();
  });

  it("cruise has fixed windows", () => {
    const plan = Plan.parse(cruise);
    expect(plan.days.some((d) => d.stops.some((s) => s.fixed && s.from && s.to))).toBe(true);
  });

  it("state fixtures are consistent", () => {
    expect(stateEmpty.version).toBeNull();
    expect(stateBusy.busy).toBe(true);
    expect(stateOutdated.outdated).toBe(true);
    expect(Plan.safeParse(stateOutdated.version.plan).success).toBe(true);
    for (const m of stateOutdated.versions) {
      if (m.feedback && "kind" in m.feedback) expect(PlanEdit.safeParse(m.feedback).success).toBe(true);
      else if (m.feedback) expect(PlanFeedback.safeParse(m.feedback).success).toBe(true);
    }
  });
});

describe("Plan schema", () => {
  it("rejects a bad HH:MM", () => {
    const p = clone(golf);
    p.days[0].stops[0].acts[0].at = "24:00";
    expect(Plan.safeParse(p).success).toBe(false);
  });

  it("rejects 22 days", () => {
    const p = clone(golf);
    p.days = Array.from({ length: 22 }, (_, i) => ({ ...golf.days[0], n: Math.min(i + 1, 21) }));
    expect(Plan.safeParse(p).success).toBe(false);
  });

  it("rejects a ref that is not an OSM key", () => {
    const p = clone(golf);
    p.days[0].stops[0].acts[1].ref = "p12";
    expect(Plan.safeParse(p).success).toBe(false);
  });

  it("keeps unknown top-level keys", () => {
    const parsed = Plan.parse({ ...clone(golf), items: [{ x: 1 }], future: true });
    expect(parsed.items).toEqual([{ x: 1 }]);
    expect((parsed as Record<string, unknown>).future).toBe(true);
  });
});

describe("PlanFeedback", () => {
  it("needs a chip or text", () => {
    expect(PlanFeedback.safeParse({}).success).toBe(false);
    expect(PlanFeedback.safeParse({ text: "   " }).success).toBe(false);
    expect(PlanFeedback.safeParse({ text: "mehr Pausen" }).success).toBe(true);
    expect(PlanFeedback.parse({ chips: ["more_rest"] })).toEqual({ chips: ["more_rest"], days: [] });
  });

  it("redo_day requires a day", () => {
    expect(PlanFeedback.safeParse({ chips: ["redo_day"] }).success).toBe(false);
    expect(PlanFeedback.safeParse({ chips: ["redo_day"], days: [4] }).success).toBe(true);
  });
});

describe("isPlanOutdated", () => {
  const basis = { tripUpdatedAt: "t1", groupUpdatedAt: null, purposeUpdatedAt: "p1" };
  it("compares all three timestamps, treating missing as null", () => {
    expect(isPlanOutdated(basis, { tripUpdatedAt: "t1", purposeUpdatedAt: "p1" })).toBe(false);
    expect(isPlanOutdated(basis, { tripUpdatedAt: "t2", purposeUpdatedAt: "p1" })).toBe(true);
    expect(isPlanOutdated(basis, { tripUpdatedAt: "t1", groupUpdatedAt: "g1", purposeUpdatedAt: "p1" })).toBe(true);
    expect(isPlanOutdated(basis, { tripUpdatedAt: "t1", purposeUpdatedAt: null })).toBe(true);
  });
});
