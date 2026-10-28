import type { Plan, PlanDay, PlanEdit } from "@/lib/domain/plan";
import { diffDays } from "./patch";

/** Day content that moves with a swap; `n` and `date` stay in place. */
function content(d: PlanDay): Omit<PlanDay, "n" | "date"> {
  const { n, date, ...rest } = d;
  void n;
  void date;
  return rest;
}

function withBest(d: PlanDay, best: boolean): PlanDay {
  if (!!d.best === best) return d;
  const copy = { ...d };
  if (best) copy.best = true;
  else delete copy.best;
  return copy;
}

/** Code-only edits, no LLM [D8]. Pure; out-of-range days leave the plan unchanged. */
export function applyEdit(base: Plan, edit: PlanEdit): { plan: Plan; changedDays: number[] } {
  const total = base.days.length;
  let days = base.days;
  if (edit.kind === "swap_days") {
    const { a, b } = edit;
    if (a !== b && a <= total && b <= total) {
      const da = base.days[a - 1];
      const db = base.days[b - 1];
      days = base.days.map((d) => {
        if (d.n === a) return { n: da.n, date: da.date, ...content(db) };
        if (d.n === b) return { n: db.n, date: db.date, ...content(da) };
        return d;
      });
    }
  } else if (edit.n === null || edit.n <= total) {
    days = base.days.map((d) => withBest(d, d.n === edit.n));
  }
  if (days === base.days) return { plan: base, changedDays: [] };
  return { plan: { ...base, days }, changedDays: diffDays(base.days, days) };
}
