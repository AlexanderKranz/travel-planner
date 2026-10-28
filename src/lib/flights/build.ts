import type { FlightsFacts } from "@/lib/domain/flights";

export type BuildFlightsInput = Omit<FlightsFacts, "pairs" | "legs"> & { raw: unknown };

/** Pure builder: normalized lookups -> FlightsFacts (spec section 2.2). Stub: integrations-dev implements. */
export function buildFlightsFacts(_i: BuildFlightsInput): FlightsFacts {
  throw new Error("not implemented");
}
