import type { Trip } from "@/lib/domain/trip";

export const HORIZON_DAYS = 360;
export const TRIP_UNIT_CAP = 32;

export type FlightDates = {
  basis: "trip_dates" | "sample_week";
  outDate: string;
  backDate: string;
  mode: { out: "schedule" | "proxy"; back: "schedule" | "proxy" };
  checked: { out: string; back: string };
};

/** Dates to look up for a trip (spec section 1); null = no_dates. Stub: integrations-dev implements. */
export function flightDates(_trip: Trip, _today: string): FlightDates | null {
  return null;
}
