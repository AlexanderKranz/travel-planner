import { describe, expect, it } from "vitest";
import type { LlmPatch, Plan } from "@/lib/domain/plan";
import { assemblePlan } from "./assemble";
import { canonicalJson } from "./hash";
import { applyPatch } from "./patch";
import { header, llmDay, llmPlan, storedFor } from "./test-helpers";

const stored = storedFor(4);
const basePlan = (): Plan => {
  const llm = llmPlan(4);
  llm.days[2].best = true;
  const r = assemblePlan({ llm, stored, header: header(4), digest: {}, locale: "de" });
  if (!r.ok) throw new Error(r.reason);
  return { ...r.plan, flights: { reserved: true }, futureKey: 1 } as Plan;
};
const patch = (over: Partial<LlmPatch> = {}): LlmPatch => ({
  reply: "ok",
  days: [llmDay(2, { title: "Neu", stops: [{ place: "Cala", acts: [{ kind: "sport", text: "Runde", ref: "p3" }] }] })],
  ...over,
});

describe("applyPatch", () => {
  it("replaces only patched days; other days are the same objects", () => {
    const base = basePlan();
    const r = applyPatch({ base, patch: patch(), stored, scope: [2] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.changedDays).toEqual([2]);
    for (const n of [1, 3, 4]) expect(r.plan.days[n - 1]).toBe(base.days[n - 1]);
    expect(r.plan.days[1]).toMatchObject({ n: 2, date: "2038-03-14", title: "Neu" });
    expect(r.plan.places["node/3"]).toBeDefined();
    expect(r.plan.places["way/2"]).toBeDefined(); // still used by day 4
    expect(r.plan.summary).toBe(base.summary);
    expect(r.plan.notes).toBe(base.notes);
    expect((r.plan as Record<string, unknown>).flights).toEqual({ reserved: true });
    expect((r.plan as Record<string, unknown>).futureKey).toBe(1);
  });

  it("drops days outside the scope; only-out-of-scope fails", () => {
    const base = basePlan();
    const p = patch({ days: [llmDay(1, { title: "X" }), ...patch().days] });
    const r = applyPatch({ base, patch: p, stored, scope: [2] });
    expect(r.ok && r.plan.days[0]).toBe(base.days[0]);
    expect(applyPatch({ base, patch: patch({ days: [llmDay(1, { title: "X" })] }), stored, scope: [2] })).toEqual({ ok: false, reason: "out_of_scope_only" });
  });

  it("fails on days outside 1..N", () => {
    expect(applyPatch({ base: basePlan(), patch: patch({ days: [llmDay(9)] }), stored, scope: [] })).toEqual({ ok: false, reason: "day_count" });
  });

  it("reports no change when the patched day is identical", () => {
    const base = basePlan();
    const r = applyPatch({ base, patch: patch({ days: [llmDay(2)] }), stored, scope: [] });
    expect(r.ok && r.changedDays).toEqual([]);
  });

  it("keeps the untouched best day and removes a second best", () => {
    const base = basePlan();
    const p = patch({ days: [llmDay(2, { best: true, title: "Neu" })] });
    const r = applyPatch({ base, patch: p, stored, scope: [] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.days.filter((d) => d.best).map((d) => d.n)).toEqual([3]);
    expect(r.issues.extra_best).toBe(1);
  });

  it("replaces summary, notes and open items only when present", () => {
    const base = basePlan();
    const r = applyPatch({ base, patch: patch({ summary: "Neu.", notes: [], open: [{ text: "Buchen", day: 2 }] }), stored, scope: [] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.summary).toBe("Neu.");
    expect(r.plan.notes).toEqual([]);
    expect(r.plan.openItems).toEqual([{ text: "Buchen", day: 2 }]);
    expect(canonicalJson(r.plan.days[0])).toBe(canonicalJson(base.days[0]));
  });
});
