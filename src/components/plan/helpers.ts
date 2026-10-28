import type { ActionError } from "@/lib/domain";
import type { BudgetStatus, PlanChip, PlanEdit, PlanVersionMeta } from "@/lib/domain/plan";

/** All errors the plan routes can answer with; anything else collapses to "failed". */
const PLAN_ERRORS: readonly ActionError[] = [
  "unauthenticated",
  "invalid",
  "not_found",
  "busy",
  "conflict",
  "budget_exceeded",
  "rate_limited",
  "too_long",
  "outdated",
  "ai_disabled",
  "ai_unavailable",
  "ai_refused",
  "invalid_output",
  "failed",
];

export function asPlanError(code: unknown): ActionError {
  return PLAN_ERRORS.find((e) => e === code) ?? "failed";
}

export type ProgressStage = "facts" | "writing" | "long";

/** Staged status text by elapsed time (generation takes 30-90 s; the server gives no progress). */
export function progressStage(elapsedSec: number): ProgressStage {
  if (elapsedSec < 10) return "facts";
  if (elapsedSec < 100) return "writing";
  return "long";
}

export const POLL_INTERVAL_MS = 5_000;
export const POLL_MAX_MS = 4 * 60_000;

export function shouldKeepPolling(elapsedMs: number): boolean {
  return elapsedMs < POLL_MAX_MS;
}

export function budgetPercent(b: BudgetStatus): number {
  if (b.capMicroUsd <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((b.spentMicroUsd / b.capMicroUsd) * 100)));
}

export function budgetExhausted(b: BudgetStatus): boolean {
  return b.spentMicroUsd >= b.capMicroUsd;
}

/** Toggles `item` in `list`; refuses to grow beyond `max`. Keeps numbers sorted for stable payloads. */
export function toggleIn<T extends string | number>(list: readonly T[], item: T, max = Infinity): T[] {
  if (list.includes(item)) return list.filter((x) => x !== item);
  if (list.length >= max) return [...list];
  return [...list, item].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function range(n: number): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => i + 1);
}

export type WindowKind = "both" | "from" | "to" | null;
export function windowKind(from?: string, to?: string): WindowKind {
  if (from && to) return "both";
  if (from) return "from";
  if (to) return "to";
  return null;
}

/** Earliest sunrise and latest dusk of the listed days ("HH:MM" compares lexically). */
export function daylightRange(
  days: { sunrise: string | null; dusk: string | null }[],
): { sunrise: string; dusk: string } | null {
  const rises = days.map((d) => d.sunrise).filter((x): x is string => !!x);
  const dusks = days.map((d) => d.dusk).filter((x): x is string => !!x);
  if (rises.length === 0 || dusks.length === 0) return null;
  return { sunrise: rises.reduce((a, b) => (a < b ? a : b)), dusk: dusks.reduce((a, b) => (a > b ? a : b)) };
}

export type FeedbackSummary =
  | { type: "chips"; chips: PlanChip[]; days: number[]; text?: string }
  | { type: "swap_days"; a: number; b: number }
  | { type: "set_best"; n: number | null }
  | { type: "none" };

/** Normalises the stored feedback of a version (PlanFeedback or PlanEdit) for display. */
export function summarizeFeedback(meta: Pick<PlanVersionMeta, "feedback">): FeedbackSummary {
  const f = meta.feedback as (Partial<PlanEdit> & Record<string, unknown>) | null;
  if (!f) return { type: "none" };
  if (f.kind === "swap_days") return { type: "swap_days", a: Number(f.a), b: Number(f.b) };
  if (f.kind === "set_best") return { type: "set_best", n: f.n == null ? null : Number(f.n) };
  const chips = Array.isArray(f.chips) ? (f.chips as PlanChip[]) : [];
  const days = Array.isArray(f.days) ? (f.days as number[]) : [];
  const text = typeof f.text === "string" && f.text ? f.text : undefined;
  if (chips.length === 0 && !text) return { type: "none" };
  return { type: "chips", chips, days, text };
}

/** Only a code-only edit or an AI patch has days worth highlighting in the card list. */
export function highlightedDays(meta: Pick<PlanVersionMeta, "kind" | "changedDays"> | undefined): number[] {
  if (!meta) return [];
  return meta.kind === "patch" || meta.kind === "edit" ? meta.changedDays : [];
}
