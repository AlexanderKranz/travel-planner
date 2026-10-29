import { describe, expect, it } from "vitest";
import { Plan, type PlanDay, type PlanFeedback } from "@/lib/domain/plan";
import fixture from "./__fixtures__/copenhagen.json";
import type { PlanInputStored } from "./input";
import { actCount, allowsNoteDrop, allowsShrink, guardPatch, isShrunk } from "./patch-guard";

const input = fixture.input as unknown as PlanInputStored;
const base = () => Plan.parse(fixture.plan);
const fb = (over: Partial<PlanFeedback> = {}): PlanFeedback => ({ chips: [], days: [], ...over });
const ALEX = "für tag 1. wir machen Rathausplatz und rådhus, aber machen nicht Verdensur. auch Amagertorv streichen.";

/** Base plan with day `n` replaced by `day(base day)`. */
function withDay(b: Plan, n: number, day: (d: PlanDay) => PlanDay): Plan {
  return { ...b, days: b.days.map((d) => (d.n === n ? day(d) : d)) };
}
const keepActs = (d: PlanDay, k: number): PlanDay => ({ ...d, stops: [{ ...d.stops[0], acts: d.stops[0].acts.slice(0, k) }] });

describe("isShrunk", () => {
  it("rejects losing more than half, or everything", () => {
    expect(isShrunk(6, 2)).toBe(true);
    expect(isShrunk(6, 3)).toBe(false);
    expect(isShrunk(5, 2)).toBe(true);
    expect(isShrunk(4, 2)).toBe(false);
    expect(isShrunk(4, 1)).toBe(true);
    expect(isShrunk(2, 0)).toBe(true);
    expect(isShrunk(1, 1)).toBe(false);
    expect(isShrunk(0, 0)).toBe(false);
    expect(isShrunk(3, 6)).toBe(false);
  });
});

describe("allowsShrink / allowsNoteDrop", () => {
  it("redo_day for the day, or text clearly asking to clear the day", () => {
    expect(allowsShrink(fb({ chips: ["redo_day"], days: [1] }), 1)).toBe(true);
    expect(allowsShrink(fb({ chips: ["redo_day"], days: [2] }), 1)).toBe(false);
    expect(allowsShrink(fb({ text: "Tag 1 bitte komplett frei, wir ruhen uns aus" }), 1)).toBe(true);
    expect(allowsShrink(fb({ text: "make day 2 a free day" }), 2)).toBe(true);
    expect(allowsShrink(fb({ text: ALEX }), 1)).toBe(false);
    expect(allowsShrink(fb({ chips: ["more_rest"] }), 1)).toBe(false);
  });
  it("note/warn may go when the text mentions them", () => {
    expect(allowsNoteDrop(fb({ text: "Den Tipp an Tag 1 bitte weg" }), 1)).toBe(true);
    expect(allowsNoteDrop(fb({ text: "remove the warning" }), 2)).toBe(true);
    expect(allowsNoteDrop(fb({ text: ALEX }), 1)).toBe(false);
  });
});

describe("guardPatch", () => {
  it("keeps the base day when a patched day lost most activities, and reports it", () => {
    const b = base();
    const next = withDay(b, 1, (d) => ({ ...keepActs(d, 2), note: undefined }));
    const r = guardPatch({ base: b, next, feedback: fb({ text: ALEX }), index: input.index });
    expect(r.rejected).toEqual([{ n: 1, before: 6, after: 2 }]);
    expect(r.plan.days[0]).toBe(b.days[0]);
    expect(r.changedDays).toEqual([]);
    // Places of the reverted day are back (the stub referenced only Torvehallerne).
    for (const k of ["way/24361960", "way/30298120", "node/4458931123", "way/4294340", "way/23402125"]) expect(r.plan.places[k]).toBeDefined();
    expect(Plan.safeParse(r.plan).success).toBe(true);
  });

  it("rejects only the shrunk day; other patched days stay", () => {
    const b = base();
    let next = withDay(b, 1, (d) => keepActs(d, 1));
    next = withDay(next, 3, (d) => ({ ...d, title: "Zoo am Morgen" }));
    const r = guardPatch({ base: b, next, feedback: fb({ text: "Tag 3 umbenennen" }), index: input.index });
    expect(r.rejected.map((x) => x.n)).toEqual([1]);
    expect(r.changedDays).toEqual([3]);
    expect(r.plan.days[2].title).toBe("Zoo am Morgen");
  });

  it("accepts the shrink when the day is redone or cleared on purpose", () => {
    const b = base();
    const next = withDay(b, 1, (d) => keepActs(d, 1));
    expect(guardPatch({ base: b, next, feedback: fb({ chips: ["redo_day"], days: [1] }), index: input.index }).rejected).toEqual([]);
    const r = guardPatch({ base: b, next, feedback: fb({ text: "Tag 1: nur noch Ankunft, sonst nichts" }), index: input.index });
    expect(r.rejected).toEqual([]);
    expect(r.changedDays).toEqual([1]);
  });

  it("keeps a base note/warn that the patch dropped unless the feedback mentions it", () => {
    const b = base();
    const next = withDay(withDay(b, 1, (d) => ({ ...d, title: "Ankunft", note: undefined })), 2, (d) => ({ ...d, warn: undefined }));
    const r = guardPatch({ base: b, next, feedback: fb({ text: ALEX }), index: input.index });
    expect(r.keptNotes).toEqual([1, 2]);
    expect(r.plan.days[0]).toMatchObject({ title: "Ankunft", note: b.days[0].note });
    expect(r.plan.days[1].warn).toBe(b.days[1].warn);
    expect(r.changedDays).toEqual([1]);
    const dropped = guardPatch({ base: b, next, feedback: fb({ text: "Hinweise weglassen" }), index: input.index });
    expect(dropped.keptNotes).toEqual([]);
    expect(dropped.plan.days[0].note).toBeUndefined();
  });

  it("a reverted best day keeps the only best badge", () => {
    const b = base(); // day 2 is best
    let next = withDay(b, 2, (d) => ({ ...keepActs(d, 1), best: undefined }));
    next = withDay(next, 3, (d) => ({ ...d, best: true }));
    const r = guardPatch({ base: b, next, feedback: fb({ text: "x" }), index: input.index });
    expect(r.rejected.map((x) => x.n)).toEqual([2]);
    expect(r.plan.days.filter((d) => d.best).map((d) => d.n)).toEqual([2]);
  });

  it("passes an untouched patch through as the same object", () => {
    const b = base();
    const next = withDay(b, 4, (d) => ({ ...d, title: "Abreise" }));
    const r = guardPatch({ base: b, next, feedback: fb({ text: "x" }), index: input.index });
    expect(r.plan).toBe(next);
    expect(r.changedDays).toEqual([4]);
    expect(actCount(r.plan.days[0])).toBe(6);
  });
});
