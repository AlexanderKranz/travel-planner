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

/** Title shown when the trip has none: "Passau · Dez. · 7 Tage". Never stored. */
export function fallbackTitle(
  trip: Pick<Trip, "destination" | "lengthDays" | "timing">,
  t: Translate,
  locale: string,
): string {
  const parts = [trip.destination.name];
  if (trip.timing.kind !== "none") parts.push(timingLabel(trip.timing, locale, t));
  parts.push(t("days", { count: trip.lengthDays }));
  return parts.join(" · ");
}

export const tripTitle = (
  trip: Pick<Trip, "title" | "destination" | "lengthDays" | "timing">,
  t: Translate,
  locale: string,
) => trip.title ?? fallbackTitle(trip, t, locale);
