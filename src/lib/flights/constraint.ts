import type { TripPurpose } from "@/lib/domain/purpose";

/** Max block time in minutes from the purpose (spec section 4). Stub: backend-dev implements. */
export function maxBlockMinutes(p: TripPurpose | null): number | null {
  const h = p?.guided.maxFlightHours;
  return h ? Math.round(h * 60) : null;
}
