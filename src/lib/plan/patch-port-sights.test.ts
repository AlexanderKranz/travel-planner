/**
 * The cruise patch report of 2026-11-12: "replace the walk around 13:00 by concrete sights" with no day selected
 * changed one day only. These tests pin what the patch request and the guards do with port days.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { LlmPatch, LlmPlan, PlanFeedback } from "@/lib/domain/plan";
import { composeRequest, patchRequest } from "@/lib/server/ai/compose";
import { assemblePlan, placeholderText } from "./assemble";
import { applyPatch } from "./patch";
import { guardPatch } from "./patch-guard";
import { extendInputWithStops, stopPointsOf, stopRows } from "./stops-input";
import { CRUISE_FACTS, CRUISE_RESOLVED, CRUISE_STOPS, emptyStored } from "./stops-test-helpers";
import { header } from "./test-helpers";

const stored = extendInputWithStops(emptyStored(), { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf(CRUISE_RESOLVED), facts: CRUISE_FACTS, lang: "de" });
const wien = stored.llm.stopPlaces![0];
const dom = wien.places!.find((p) => p.name === "Stephansdom")!.id;
const zoo = wien.places!.find((p) => p.name === "Zoo Wien")!.id;

type Acts = LlmPlan["days"][number]["stops"][number]["acts"];
const day = (n: number, place: string, acts: Acts) => ({ n, title: `Tag ${n}`, stops: [{ place, acts }] });
const walk = { at: "13:00", kind: "free" as const, text: "Spaziergang am Wasser" };
const base = (() => {
  const r = assemblePlan({
    llm: {
      summary: "Donau.",
      days: [day(1, "Passau", [walk]), day(2, "Wien", [{ ...walk, at: "15:00" }]), day(3, "Dürnstein", [{ ...walk, at: "09:00" }]), day(4, "An Bord", []), day(5, "Passau", [walk])],
      notes: [],
      open: [],
      packing: [],
    },
    stored,
    header: { ...header(5), lengthDays: 5, timing: { kind: "none" } },
    digest: {},
    locale: "de",
  });
  if (!r.ok) throw new Error("base");
  return r.plan;
})();
const feedback: PlanFeedback = { chips: [], days: [], text: "Ersetze den Spaziergang durch konkrete Sehenswürdigkeiten" } as PlanFeedback;

describe("patch request on a trip with stops", () => {
  it("INPUT is the stored input: the same per-stop pools (sights and restaurants) as the generate request", () => {
    const gen = composeRequest(stored.llm).blocks[0].text;
    const req = patchRequest({ llm: stored.llm, plan: base, index: stored.index, feedback });
    expect(req.blocks[0].text).toBe(gen);
    const input = JSON.parse(gen.slice("INPUT\n".length));
    expect(input.stopPlaces[0].places.map((p: { name: string }) => p.name)).toContain("Stephansdom");
    expect(input.stopPlaces[0].restaurants.list.length).toBeGreaterThan(0);
  });

  it("no days selected: FEEDBACK has no days, every day is in full in CURRENT_PLAN", () => {
    const req = patchRequest({ llm: stored.llm, plan: base, index: stored.index, feedback });
    const fb = JSON.parse(req.blocks[2].text.slice("FEEDBACK\n".length));
    expect(fb.days).toBeUndefined();
    const current = JSON.parse(req.blocks[1].text.slice("CURRENT_PLAN\n".length));
    expect(current.days.every((d: { stops?: unknown }) => Array.isArray(d.stops))).toBe(true);
  });

  it("plan-9: the addendum asks for every concerned day and refs from each day's lists", () => {
    const req = patchRequest({ llm: stored.llm, plan: base, index: stored.index, feedback });
    expect(req.system).toMatch(/Otherwise change every day the request concerns/);
    expect(req.system).toMatch(/give each such item a ref \(rules 3, 16, 17\) wherever that day's lists have a fitting id/);
  });
});

describe("guards on a patch that replaces walks by port sights", () => {
  const patch: LlmPatch = {
    reply: "ok",
    days: [
      day(2, "Wien", [{ at: "15:00", kind: "see", text: "Dom innen und außen", ref: dom, alts: [zoo] }]),
      // Wien's sight on the Dürnstein day: the stop-ref guard drops the ref, the new text stays.
      day(3, "Dürnstein", [{ at: "09:00", kind: "see", text: "Besichtigung", ref: dom }]),
    ],
  };

  it("a port sight of the day's own stop is kept; a wrong stop's ref is dropped but the day still counts as changed", () => {
    const r = applyPatch({ base, patch, stored, scope: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changedDays).toEqual([2, 3]);
    const a2 = r.plan.days[1].stops[0].acts[0];
    expect(a2).toMatchObject({ ref: stored.index[dom].key, alts: [stored.index[zoo].key] });
    const a3 = r.plan.days[2].stops[0].acts[0];
    expect(a3.ref).toBeUndefined();
    expect(a3.text).toBe("Besichtigung");
    expect(r.issues.stop_mismatch).toBe(1);
    // The shrink guard leaves both days alone (one activity each, as before).
    const g = guardPatch({ base, next: r.plan, feedback, index: stored.index });
    expect(g.rejected).toEqual([]);
    expect(g.changedDays).toEqual([2, 3]);
  });
});

describe('placeholder texts (live portsights answer of 2026-11-12: text "x" on a new sight)', () => {
  it("a placeholder text with a ref falls back to the place name; without a ref the activity is dropped", () => {
    const r = applyPatch({
      base,
      patch: { reply: "ok", days: [day(2, "Wien", [{ at: "15:00", kind: "see", text: "x", ref: dom }, { at: "16:00", kind: "free", text: "–" }])] },
      stored,
      scope: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.days[1].stops[0].acts).toEqual([expect.objectContaining({ text: "Stephansdom", ref: stored.index[dom].key })]);
  });

  it("real short texts stay", () => {
    expect(placeholderText("Zoo")).toBe(false);
    expect(placeholderText("Bootsfahrt, 1 Std.")).toBe(false);
    expect(placeholderText("x")).toBe(true);
    expect(placeholderText(" - ")).toBe(true);
    expect(placeholderText("…")).toBe(true);
    expect(placeholderText(undefined)).toBe(false);
  });
});
