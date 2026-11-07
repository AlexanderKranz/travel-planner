import { describe, expect, it } from "vitest";
import { Plan, type PlanDay, type PlanFeedback } from "@/lib/domain/plan";
import fixture from "./__fixtures__/copenhagen.json";
import type { PlanInputStored } from "./input";
import { dropOverlaps } from "./fixed-items";
import { MAX_REPLACED_PER_ACT, MAX_REPLACING_MIN, actCount, allowsNoteDrop, allowsShrink, guardPatch, isShrunk, lostActs } from "./patch-guard";

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

  // Issue #158: "golf on every day" replaces most of a full day with one long round at a verified course.
  type Act = PlanDay["stops"][number]["acts"][number];
  const REF = "way/24361960" as const; // in the fixture's index
  const golf = (from: string, until: string, over: Partial<Act> = {}): Act => ({ at: from, until, kind: "sport", text: "18 Löcher", ref: REF, ...over });
  // Day 1 of the fixture: arrival (no time), then 13:00 lunch, 14:15, 15:30, 16:45 and 18:30 dinner. `only(act)` keeps
  // the arrival and puts the act in place of everything else: 6 -> 2 activities, shrunk by count.
  const only = (b: Plan, act: Act) => withDay(b, 1, (d) => ({ ...d, stops: [{ ...d.stops[0], acts: [d.stops[0].acts[0], act] }] }));
  const feedback = fb({ text: "wir möchten an jedem tag golf spielen" });
  const verified = new Set(Object.values(input.index).map((e) => e.key as string));
  const rejectedFor = (b: Plan, act: Act) => guardPatch({ base: b, next: only(b, act), feedback, index: input.index }).rejected.map((x) => x.n);

  it("accepts a day where a round at a verified course took the time of the dropped activities", () => {
    const b = base();
    const next = only(b, golf("13:00", "18:30"));
    expect(actCount(next.days[0])).toBe(2);
    // Four dropped activities start inside the round, but one round replaces at most 3; 16:45 and dinner are lost.
    expect(lostActs(b.days[0], next.days[0], verified)).toBe(2);
    const r = guardPatch({ base: b, next, feedback, index: input.index });
    expect(r.rejected).toEqual([]);
    expect(r.changedDays).toEqual([1]);
  });

  it("rejects a day wiped by one blanket activity (QA H1)", () => {
    const b = base();
    expect(rejectedFor(b, { kind: "do", text: "Entdecken", at: "08:00", until: "22:00" })).toEqual([1]); // no ref
    expect(rejectedFor(b, { kind: "do", text: "Stadtbummel", at: "13:00", until: "18:30" })).toEqual([1]); // generic, no ref
    expect(rejectedFor(b, golf("08:00", "22:00"))).toEqual([1]); // longer than MAX_REPLACING_MIN
    expect(rejectedFor(b, golf("12:00", "20:00", { kind: "food" }))).toEqual([1]); // a long meal
    expect(rejectedFor(b, golf("13:00", "18:30", { kind: "free" }))).toEqual([1]);
    expect(rejectedFor(b, golf("13:00", "18:30", { ref: "node/1" }))).toEqual([1]); // not a verified place
    expect(rejectedFor(b, golf("13:00", "18:30", { until: undefined }))).toEqual([1]);
    expect(rejectedFor(b, golf("13:00", "14:00"))).toEqual([1]); // covers only lunch
    expect(MAX_REPLACING_MIN).toBe(360);
    expect(MAX_REPLACED_PER_ACT).toBe(3);
  });

  it("window boundaries: start inclusive, until exclusive, end within 30 min slack, untimed stays lost (QA M1)", () => {
    const see = (at: string | undefined, until: string | undefined, text: string): Act => ({ kind: "see", text, ...(at ? { at } : {}), ...(until ? { until } : {}) });
    const day = (acts: Act[]): PlanDay => ({ n: 1, date: null, title: "T", stops: [{ place: "Marbella", acts }] }) as PlanDay;
    const baseDay = day([
      see("09:00", "10:00", "before the round"),
      see("10:00", "11:00", "at the round's start"),
      see("11:00", "12:30", "ends 30 min after"),
      see("11:30", "13:00", "ends 60 min after"),
      see("12:00", "13:00", "at the round's until"),
      see(undefined, undefined, "untimed"),
    ]);
    const next = day([golf("10:00", "12:00")]);
    // Replaced: "at the round's start" and "ends 30 min after"; the other four are lost.
    expect(lostActs(baseDay, next, verified)).toBe(4);
  });

  it("acts of a fixed stop are never replaced; a round over a fixed item is dropped before the guard (QA M2)", () => {
    const fixedDay: PlanDay = {
      n: 1,
      date: null,
      title: "Hafen",
      stops: [
        { place: "Hafen", from: "08:00", to: "12:00", fixed: true, acts: [{ kind: "see", text: "Altstadt", at: "09:00", until: "10:00" }, { kind: "see", text: "Markt", at: "10:30", until: "11:30" }] },
      ],
    } as PlanDay;
    const patched: PlanDay = { ...fixedDay, stops: [{ ...fixedDay.stops[0], acts: [] }, { place: "Marbella", acts: [golf("08:30", "12:00")] }] };
    expect(lostActs(fixedDay, patched, verified)).toBe(2);

    // Fixed items (INPUT.fixed) are not acts: applyPatch's guardFixed drops an added act that overlaps one, so it
    // cannot stand in for anything when D3 runs.
    const b = base();
    const next = only(b, golf("13:00", "18:30"));
    const cut = dropOverlaps(next.days[0], [{ day: 1, from: "14:00", to: "15:00" }]);
    expect(cut.dropped).toBe(1);
    const guarded = guardPatch({ base: b, next: withDay(b, 1, () => cut.day), feedback, index: input.index });
    expect(guarded.rejected.map((x) => x.n)).toEqual([1]);
  });

  it("an empty patched day is rejected whatever it replaced", () => {
    const b = base();
    const empty = withDay(b, 1, (d) => ({ ...d, stops: [{ ...d.stops[0], acts: [] }] }));
    expect(guardPatch({ base: b, next: empty, feedback, index: input.index }).rejected.map((x) => x.n)).toEqual([1]);
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
