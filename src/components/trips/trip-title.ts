import type { Trip, TripTiming } from "@/lib/domain";

export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Short month name, locale aware ("Dez." / "Dec"). */
export function monthName(month: number, locale: string, style: "short" | "long" = "short"): string {
  return new Intl.DateTimeFormat(locale, { month: style, timeZone: "UTC" }).format(
    new Date(Date.UTC(2000, month - 1, 15)),
  );
}

/** Human summary of the timing, or null when open. `t` is the `trips` namespace translator. */
export function timingLabel(timing: TripTiming, locale: string, t: Translate): string {
  if (timing.kind === "date") {
    const [y, m, d] = timing.startDate.split("-").map(Number);
    const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(Date.UTC(y, m - 1, d)),
    );
    return t("timing.fromDate", { date });
  }
  if (timing.kind === "months") {
    const list = new Intl.ListFormat(locale, { type: "disjunction" }).format(
      timing.months.map((m) => monthName(m, locale)),
    );
    return list;
  }
  return t("timing.openShort");
}

/**
 * Title shown when the trip has none: the destination name. Never stored. Dates and length are not repeated here:
 * cards and the trip header show them in their own line (Alex, 2026-11-12).
 */
export function fallbackTitle(trip: Pick<Trip, "destination">): string {
  return trip.destination.name;
}

export const tripTitle = (trip: Pick<Trip, "title" | "destination">) => trip.title ?? fallbackTitle(trip);
