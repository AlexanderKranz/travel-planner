import type { Plan } from "@/lib/domain/plan";
import type { Trip } from "@/lib/domain/trip";
import { DEFAULT_HOME_TIMEZONE, formatHours, isValidTimeZone, timeDifferenceMinutes } from "./time-difference";
import { referenceDates } from "./trip-timing";

/**
 * Display value of the time difference for plan view, share page and PDF (same wording everywhere).
 * Contains nothing but what is shown: no zone names, no raw offsets. Render with `facts.timeDifference.*` messages.
 */
export type PlanTimeDifference = {
  /** "ahead"/"behind": `hours` is unsigned ("8", "5:30"). "range": daylight saving differs, `hours` = "+1", `to` = "+2". */
  kind: "ahead" | "behind" | "range";
  hours: string;
  to?: string;
  /** Owner's home place name; null = default (Germany, localized by the renderer). */
  home: string | null;
  /** Qualifiers, in display order. */
  notes: ("current" | "changes" | "byMonth")[];
};

export type PlanHome = { name: string | null; timezone: string | null };

/**
 * Time difference destination vs. the plan owner's home, from the plan snapshot (destination zone =
 * facts.daylight.timezone, dates = header.timing). Null when there is no destination zone, a zone is invalid
 * or the difference is zero. Pure; never part of the LLM input or the plan hash.
 */
export function planTimeDifference(
  plan: Pick<Plan, "header" | "facts">,
  home: PlanHome | null,
  today: string,
): PlanTimeDifference | null {
  const dest = plan.facts.daylight?.timezone;
  const homeZone = home?.timezone ?? DEFAULT_HOME_TIMEZONE;
  if (!dest || !isValidTimeZone(dest) || !isValidTimeZone(homeZone)) return null;
  const { timing, lengthDays } = plan.header;
  const tripTiming: Trip["timing"] =
    timing.kind === "date"
      ? { kind: "date", startDate: timing.startDate }
      : timing.kind === "months"
        ? { kind: "months", months: timing.months }
        : { kind: "none" };
  const refs = referenceDates({ timing: tripTiming, lengthDays }, today);
  const minutes = timeDifferenceMinutes(dest, homeZone, refs.length ? refs : [today]);
  if (minutes.length === 0) return null;
  const homeName = home?.timezone && home.name ? home.name : null;
  const notes: PlanTimeDifference["notes"] = [];
  if (refs.length === 0) notes.push("current");
  if (minutes.length > 1) {
    notes.push(timing.kind === "months" ? "byMonth" : "changes");
    return {
      kind: "range",
      hours: formatHours(Math.min(...minutes)),
      to: formatHours(Math.max(...minutes)),
      home: homeName,
      notes,
    };
  }
  const m = minutes[0];
  if (m === 0) return null;
  return { kind: m > 0 ? "ahead" : "behind", hours: formatHours(Math.abs(m)).slice(1), home: homeName, notes };
}

type Translate = (key: string, vars?: Record<string, string>) => string;

/**
 * One line of text, identical on web and PDF: "8 h ahead of Germany. Changes during the trip (daylight saving)."
 * `t` resolves the `timeAhead`, `timeBehind`, `timeRange`, `timeCurrent`, `timeChanges`, `timeByMonth` and
 * `timeDefaultHome` keys of the web (`plan.facts`) or PDF (`pdf.facts`) namespace.
 */
export function planTimeDifferenceText(td: PlanTimeDifference, t: Translate): string {
  const home = td.home ?? t("timeDefaultHome");
  const main =
    td.kind === "range"
      ? t("timeRange", { from: td.hours, to: td.to ?? td.hours, home })
      : t(td.kind === "ahead" ? "timeAhead" : "timeBehind", { diff: td.hours, home });
  const notes = td.notes.map((n) => t(n === "current" ? "timeCurrent" : n === "changes" ? "timeChanges" : "timeByMonth"));
  return [main, ...notes].join(" ");
}
