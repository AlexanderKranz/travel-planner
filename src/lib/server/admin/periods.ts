import { berlinMidnight } from "../ai-usage";

const berlinDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });

/** Boundaries for the admin queries and the budget cron, all Europe/Berlin (same day as the AI/ORS/AeroDataBox caps). */
export function adminPeriods(now: Date = new Date()) {
  const [, , dd] = berlinDate.format(now).split("-").map(Number);
  return {
    now,
    dayStart: berlinMidnight(now),
    monthStart: berlinMidnight(now, -(dd - 1)),
    last24h: new Date(now.getTime() - 24 * 3_600_000),
  };
}
export type AdminPeriods = ReturnType<typeof adminPeriods>;
