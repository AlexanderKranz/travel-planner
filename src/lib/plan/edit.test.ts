import { describe, expect, it } from "vitest";
import golf from "@/lib/plan/__fixtures__/plan-golf.json";
import copenhagen from "@/lib/plan/__fixtures__/copenhagen.json";
import { Plan, isUserBest, type PlanDay } from "@/lib/domain/plan";
import { applyEdit, promoteAlt, removeActivity, removeAlt } from "./edit";

const base = () => Plan.parse(golf);

describe("applyEdit", () => {
  it("swap_days swaps content and keeps n/date", () => {
    const b = base();
    const r = applyEdit(b, { kind: "swap_days", a: 1, b: 3 });
    expect(r.changedDays).toEqual([1, 3]);
    expect(r.plan.days[0]).toMatchObject({ n: 1, date: b.days[0].date, title: b.days[2].title, stops: b.days[2].stops });
    expect(r.plan.days[2]).toMatchObject({ n: 3, date: b.days[2].date, title: b.days[0].title });
    expect(r.plan.days[1]).toBe(b.days[1]);
    expect(Plan.safeParse(r.plan).success).toBe(true);
  });

  it("swap with itself or out of range changes nothing", () => {
    const b = base();
    expect(applyEdit(b, { kind: "swap_days", a: 2, b: 2 })).toEqual({ plan: b, changedDays: [] });
    expect(applyEdit(b, { kind: "swap_days", a: 2, b: 9 }).changedDays).toEqual([]);
  });

  it("set_best marks a user best day and clears every other (also an older AI best); null clears it", () => {
    const b = base(); // stored before plan-5: one AI-set best without bestBy, not shown
    const old = b.days.find((d) => d.best)!.n;
    expect(isUserBest(b.days[old - 1])).toBe(false);
    const target = old === 1 ? 2 : 1;
    const r = applyEdit(b, { kind: "set_best", n: target });
    expect(r.plan.days.filter((d) => d.best).map((d) => d.n)).toEqual([target]);
    expect(isUserBest(r.plan.days[target - 1])).toBe(true);
    expect(r.changedDays.sort()).toEqual([old, target].sort());
    expect("best" in r.plan.days[old - 1]).toBe(false);
    // Marking the AI best day makes it the user's.
    const same = applyEdit(b, { kind: "set_best", n: old });
    expect(same.changedDays).toEqual([old]);
    expect(applyEdit(same.plan, { kind: "set_best", n: old }).changedDays).toEqual([]);
    const cleared = applyEdit(same.plan, { kind: "set_best", n: null });
    expect(cleared.plan.days.some((d) => d.best || d.bestBy)).toBe(false);
    expect(cleared.changedDays).toEqual([old]);
  });
});

describe("activity edits without AI (patch-safety [D7])", () => {
  const cph = () => Plan.parse(copenhagen.plan);
  const RATHAUS = { n: 1, s: 0, a: 2 }; // Rathausplatz, alts Rådhus + Verdensur
  const STROEGET = { n: 1, s: 0, a: 4 }; // Strøget, alt Amagertorv
  const [RADHUS, VERDENSUR, AMAGERTORV] = ["way/30298120", "node/4458931123", "way/23402125"];

  it("removeAlt drops one alternative, and the alts key with the last one", () => {
    const d = cph().days[0];
    expect(removeAlt(d, RATHAUS, VERDENSUR).stops[0].acts[2].alts).toEqual([RADHUS]);
    const last = removeAlt(d, STROEGET, AMAGERTORV).stops[0].acts[4];
    expect("alts" in last).toBe(false);
    expect(removeAlt(d, STROEGET, "way/999")).toBe(d);
    expect(removeAlt(d, { n: 1, s: 0, a: 11 }, AMAGERTORV)).toBe(d);
  });

  it("Alex's case: two alternatives removed, everything else stays", () => {
    const b = cph();
    const one = applyEdit(b, { kind: "remove_alt", ...RATHAUS, alt: VERDENSUR });
    const two = applyEdit(one.plan, { kind: "remove_alt", ...STROEGET, alt: AMAGERTORV });
    expect(one.changedDays).toEqual([1]);
    const day = two.plan.days[0];
    expect(day.stops[0].acts).toHaveLength(6);
    expect(day.note).toBe(b.days[0].note);
    expect(two.plan.places[VERDENSUR]).toBeUndefined();
    expect(two.plan.places[AMAGERTORV]).toBeUndefined();
    expect(two.plan.places[RADHUS]).toBeDefined();
    for (const d of [2, 3, 4]) expect(two.plan.days[d - 1]).toBe(b.days[d - 1]);
    expect(Plan.safeParse(two.plan).success).toBe(true);
  });

  it("promoteAlt swaps the main place with the alternative in the same slot", () => {
    const d = cph().days[0];
    const act = promoteAlt(d, RATHAUS, VERDENSUR).stops[0].acts[2];
    expect(act.ref).toBe(VERDENSUR);
    expect(act.alts).toEqual([RADHUS, "way/24361960"]);
    expect(act.text).toBe(d.stops[0].acts[2].text);
    expect(promoteAlt(d, { n: 1, s: 0, a: 0 }, VERDENSUR)).toBe(d); // no ref, nothing to promote
  });

  it("removeActivity drops one activity; an emptied extra stop goes, a fixed or only stop stays", () => {
    const b = cph();
    const r = applyEdit(b, { kind: "remove_act", n: 1, s: 0, a: 4 });
    expect(r.plan.days[0].stops[0].acts.map((a) => a.ref)).not.toContain("way/4294340");
    expect(r.plan.days[0].stops[0].acts).toHaveLength(5);
    expect(r.plan.places["way/4294340"]).toBeUndefined();
    expect(r.changedDays).toEqual([1]);
    const two: PlanDay = {
      ...b.days[0],
      stops: [
        { place: "A", acts: [{ kind: "do", text: "x" }] },
        { place: "B", acts: [{ kind: "do", text: "y" }] },
      ],
    };
    expect(removeActivity(two, { n: 1, s: 0, a: 0 }).stops.map((s) => s.place)).toEqual(["B"]);
    const fixed: PlanDay = { ...two, stops: [{ ...two.stops[0], from: "08:00", to: "12:00", fixed: true }, two.stops[1]] };
    expect(removeActivity(fixed, { n: 1, s: 0, a: 0 }).stops[0]).toMatchObject({ place: "A", acts: [] });
    const only: PlanDay = { ...b.days[0], stops: [{ place: "A", acts: [{ kind: "do", text: "x" }] }] };
    expect(removeActivity(only, { n: 1, s: 0, a: 0 }).stops).toEqual([{ place: "A", acts: [] }]);
  });

  it("out-of-range days or addresses change nothing", () => {
    const b = cph();
    expect(applyEdit(b, { kind: "remove_act", n: 9, s: 0, a: 0 })).toEqual({ plan: b, changedDays: [] });
    expect(applyEdit(b, { kind: "remove_act", n: 1, s: 3, a: 0 }).changedDays).toEqual([]);
    expect(applyEdit(b, { kind: "remove_alt", n: 1, s: 0, a: 1, alt: VERDENSUR }).changedDays).toEqual([]);
  });
});
