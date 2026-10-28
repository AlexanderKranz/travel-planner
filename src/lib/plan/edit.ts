import type { Plan, PlanEdit } from "@/lib/domain/plan";
import { notImplemented } from "./not-implemented";

/** Code-only edits, no LLM [D8]. */
export function applyEdit(base: Plan, edit: PlanEdit): { plan: Plan; changedDays: number[] } {
  void base;
  void edit;
  return notImplemented("applyEdit");
}
