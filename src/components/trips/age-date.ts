import type { TripTiming } from "@/lib/domain";

/**
 * Date used to compute group ages (spec section 5, D4/D17):
 * exact date -> start date; months -> earliest "15th of the next occurrence"; none -> today.
 */
export function ageDateFor(timing: TripTiming, today: string): string {
  if (timing.kind === "date") return timing.startDate;
  if (timing.kind !== "months") return today;
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const dates = timing.months.map((m) => {
    const y = m >= month ? year : year + 1; // current month counts as upcoming
    return `${y}-${String(m).padStart(2, "0")}-15`;
  });
  return dates.sort()[0] ?? today;
}

/** Today as YYYY-MM-DD in Europe/Berlin. */
export function berlinToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
