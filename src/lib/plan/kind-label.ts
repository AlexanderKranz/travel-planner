/**
 * Message key (under `kinds.`) for an activity kind. A `travel` item reads
 * "arrival" on the first day, "departure" on the last day and plain "travel"
 * otherwise (also for a one-day trip or an unknown day count).
 */
export function kindLabelKey(kind: string, dayIndex: number, dayCount?: number): string {
  if (kind !== "travel" || !dayCount || dayCount < 2) return kind;
  if (dayIndex === 0) return "travelArrival";
  if (dayIndex === dayCount - 1) return "travelDeparture";
  return kind;
}
