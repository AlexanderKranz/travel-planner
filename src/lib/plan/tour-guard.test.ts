import { describe, expect, it } from "vitest";
import type { PlanActivity } from "@/lib/domain/plan";
import { assemblePlan } from "./assemble";
import { applyPatch } from "./patch";
import { header, llmDay, llmPlan, storedFor } from "./test-helpers";
import { guardTourDuplicates, tourStopsByDay } from "./tour-guard";

const names = new Map([
  ["way/1", "Aloha"],
  ["way/2", "Brisas"],
  ["node/3", "Cala"],
]);
const act = (over: Partial<PlanActivity> = {}): PlanActivity => ({ at: "09:00", kind: "see", text: "Aloha besuchen", ref: "way/1", ...over });

describe("guardTourDuplicates", () => {
  it("replaces a ref that is a tour stop by its first alternative that is none, and names the new place", () => {
    const r = guardTourDuplicates(act({ alts: ["way/2", "node/3"] }), new Set(["way/1"]), names);
    expect(r.dropped).toBe(1);
    expect(r.act).toMatchObject({ ref: "way/2", alts: ["node/3"], text: "Brisas besuchen" });
  });
  it("skips alternatives that are tour stops too", () => {
    const r = guardTourDuplicates(act({ alts: ["way/2", "node/3"] }), new Set(["way/1", "way/2"]), names);
    expect(r.act).toMatchObject({ ref: "node/3" });
    expect(r.act?.alts).toBeUndefined();
    expect(r.dropped).toBe(2);
  });
  it("drops the activity when no valid alternative is left", () => {
    expect(guardTourDuplicates(act({ alts: ["way/2"] }), new Set(["way/1", "way/2"]), names)).toEqual({ act: null, dropped: 2 });
    expect(guardTourDuplicates(act(), new Set(["way/1"]), names)).toEqual({ act: null, dropped: 1 });
  });
  it("removes only an alternative that is a tour stop and keeps the ref", () => {
    const r = guardTourDuplicates(act({ alts: ["way/2"] }), new Set(["way/2"]), names);
    expect(r.act).toEqual(act());
    expect(r.dropped).toBe(1);
  });
  it("leaves other activities alone (same object)", () => {
    const a = act();
    expect(guardTourDuplicates(a, new Set(["node/3"]), names).act).toBe(a);
    expect(guardTourDuplicates(a, undefined).act).toBe(a);
    const free = act({ ref: undefined });
    expect(guardTourDuplicates(free, new Set(["way/1"])).act).toBe(free);
  });
  it("reads the stored per-day keys", () => {
    expect(tourStopsByDay({ "2": ["way/1"], "3": [] })).toEqual(new Map([[2, new Set(["way/1"])]]));
    expect(tourStopsByDay(undefined)).toBeUndefined();
  });
});

describe("duplicate guard in assembly (city-tour 10)", () => {
  // Day 1 uses p1 (way/1), day 2 uses p2 (way/2) with p3 as alternative.
  const llm = llmPlan(3, {
    days: [llmDay(1), llmDay(2, { stops: [{ place: "Marbella", acts: [{ at: "09:00", kind: "sport", text: "Brisas spielen", ref: "p2", alts: ["p3"] }] }] }), llmDay(3)],
  });

  it("generate: only the tour's day is guarded; the ref is swapped and logged as tour_duplicate", () => {
    const stored = { ...storedFor(3), tourStops: { "2": ["way/2" as const, "way/1" as const] } };
    const r = assemblePlan({ llm, stored, header: header(3), digest: {}, locale: "de" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.issues.tour_duplicate).toBe(1);
    expect(r.plan.days[1].stops[0].acts[0]).toMatchObject({ ref: "node/3", text: "Cala spielen" });
    expect(r.plan.days[0].stops[0].acts[0].ref).toBe("way/1"); // day 1 has no tour
    expect(r.plan.places["way/2"]).toBeUndefined();
  });

  it("without tour stops the plan is unchanged", () => {
    const stored = storedFor(3);
    const a = assemblePlan({ llm, stored, header: header(3), digest: {}, locale: "de" });
    if (!a.ok) throw new Error(a.reason);
    expect(a.issues.tour_duplicate).toBe(0);
    expect(a.plan.days[1].stops[0].acts[0].ref).toBe("way/2");
  });

  it("patch: the current tours guard the patched day; explicit undefined means no tours now", () => {
    const stored = storedFor(3);
    const base = assemblePlan({ llm: llmPlan(3), stored, header: header(3), digest: {}, locale: "de" });
    if (!base.ok) throw new Error(base.reason);
    const patch = { reply: "ok", days: [llmDay(2, { stops: [{ place: "Marbella", acts: [{ at: "09:00", kind: "see", text: "Aloha", ref: "p1" }] }] })] };
    const guarded = applyPatch({ base: base.plan, patch, stored, scope: [2], tourStops: { "2": ["way/1"] } });
    if (!guarded.ok) throw new Error(guarded.reason);
    expect(guarded.issues.tour_duplicate).toBe(1);
    expect(guarded.plan.days[1].stops[0].acts).toEqual([]);
    // The stored input had a tour, the user unlinked it since: the current state (none) wins.
    const withStored = { ...stored, tourStops: { "2": ["way/1" as const] } };
    const free = applyPatch({ base: base.plan, patch, stored: withStored, scope: [2], tourStops: undefined });
    if (!free.ok) throw new Error(free.reason);
    expect(free.issues.tour_duplicate).toBe(0);
    // Not given at all: the stored ones apply.
    const fallback = applyPatch({ base: base.plan, patch, stored: withStored, scope: [2] });
    expect(fallback.ok && fallback.issues.tour_duplicate).toBe(1);
  });
});
