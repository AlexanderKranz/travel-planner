/**
 * Replays the live Copenhagen patch recordings (evals/patch-shrink.eval.ts, docs/specs/patch-safety.md) through the
 * real code path: normalizePatch → applyPatch → guardPatch. No API calls.
 */
import { describe, expect, it, vi } from "vitest";
import { Plan, type PlanFeedback } from "@/lib/domain/plan";
import type { PlanInputStored } from "@/lib/plan/input";
import { applyPatch } from "@/lib/plan/patch";
import { actCount, guardPatch } from "@/lib/plan/patch-guard";
import { WirePatch, normalizePatch } from "@/lib/server/ai/compose";
import fixture from "../src/lib/plan/__fixtures__/copenhagen.json";
import stubRec from "./recorded/copenhagen.patch-stub.plan-4.json";
import fixedRec from "./recorded/copenhagen.patch-variants.json";

vi.mock("server-only", () => ({}));

type Rec = { variants: Record<string, { feedback: PlanFeedback; output: unknown }> };
const input = fixture.input as unknown as PlanInputStored;

function run(v: Rec["variants"][string]) {
  const base = Plan.parse(fixture.plan);
  const patch = normalizePatch(WirePatch.parse(v.output));
  const applied = applyPatch({ base, patch, stored: input, scope: v.feedback.days });
  if (!applied.ok) throw new Error(applied.reason);
  return { base, applied, guarded: guardPatch({ base, next: applied.plan, feedback: v.feedback, index: input.index }) };
}

describe("Copenhagen patch, recorded with plan-4 (the live bug)", () => {
  const stubs = ["a", "b", "c"] as const;

  it.each(stubs)("variant %s: the model returned a 2-activity stub for day 1", (id) => {
    const { applied } = run((stubRec as Rec).variants[id]);
    const day1 = applied.plan.days[0];
    // What Alex saw: arrival + "Torvehallerne · Torvehallerne" (empty text fell back to the place name before [D6]).
    expect(actCount(day1)).toBe(2);
    expect(day1.note).toBeUndefined();
    expect(applied.changedDays).toEqual([1]);
  });

  it.each(stubs)("variant %s: the shrink guard keeps the base day and reports it", (id) => {
    const { base, guarded } = run((stubRec as Rec).variants[id]);
    expect(guarded.rejected).toEqual([{ n: 1, before: 6, after: 2 }]);
    expect(guarded.changedDays).toEqual([]);
    expect(guarded.plan.days[0]).toBe(base.days[0]);
    expect(guarded.plan.notes).toEqual(base.notes); // variant c also sent notes: [] and open: [] ([D5])
    expect(guarded.plan.openItems).toEqual(base.openItems);
  });

  it("the empty lunch text now falls back to the base text, not the place name ([D6])", () => {
    const { applied } = run((stubRec as Rec).variants.a);
    expect(applied.plan.days[0].stops[0].acts[1].text).toBe("Einfaches Mittagessen in der Markthalle mit lokalen Spezialitäten");
  });
});

describe("Copenhagen patch, recorded with plan-5 (prompt fix)", () => {
  it.each(["a", "b", "c", "d"])("variant %s: only the two alternatives are gone", (id) => {
    const { base, guarded } = run((fixedRec as Rec).variants[id]);
    expect(guarded.rejected).toEqual([]);
    expect(guarded.changedDays).toEqual([1]);
    const acts = guarded.plan.days[0].stops[0].acts;
    expect(acts).toHaveLength(6);
    expect(acts[2]).toMatchObject({ ref: "way/24361960", alts: ["way/30298120"] });
    expect(acts[4].ref).toBe("way/4294340");
    expect(acts[4].alts).toBeUndefined();
    expect(acts.map((a) => a.text)).toEqual(base.days[0].stops[0].acts.map((a) => a.text));
    expect(guarded.plan.days[0].note).toBe(base.days[0].note);
  });
});
