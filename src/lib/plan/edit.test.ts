import { describe, expect, it } from "vitest";
import golf from "@/lib/plan/__fixtures__/plan-golf.json";
import { Plan } from "@/lib/domain/plan";
import { applyEdit } from "./edit";

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

  it("set_best moves the badge; null clears it", () => {
    const b = base();
    const old = b.days.find((d) => d.best)!.n;
    const target = old === 1 ? 2 : 1;
    const r = applyEdit(b, { kind: "set_best", n: target });
    expect(r.plan.days.filter((d) => d.best).map((d) => d.n)).toEqual([target]);
    expect(r.changedDays.sort()).toEqual([old, target].sort());
    expect("best" in r.plan.days[old - 1]).toBe(false);
    const cleared = applyEdit(b, { kind: "set_best", n: null });
    expect(cleared.plan.days.some((d) => d.best)).toBe(false);
    expect(cleared.changedDays).toEqual([old]);
    expect(applyEdit(b, { kind: "set_best", n: old }).changedDays).toEqual([]);
  });
});
