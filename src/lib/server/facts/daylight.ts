import "server-only";
import type { DaylightFacts, Fact, FactsCtx } from "@/lib/domain/facts";
import type { Trip } from "@/lib/domain/trip";
import { daylightFor } from "@/lib/facts/daylight";
import { daylightDates } from "@/lib/facts/trip-timing";
import { geoDestination, unavailable } from "./common";

export async function getDaylightFacts(trip: Trip, ctx: FactsCtx): Promise<Fact<DaylightFacts>> {
  try {
    const dest = geoDestination(trip);
    if (!dest || !dest.timezone) return unavailable("no_location");
    const { basis, dates } = daylightDates(trip, ctx.today);
    return {
      status: "ok",
      data: { timezone: dest.timezone, basis, days: daylightFor(dest.lat, dest.lon, dates) },
      source: "suncalc",
      fetchedAt: new Date().toISOString(),
      stale: false,
    };
  } catch {
    return unavailable("provider_error", "suncalc");
  }
}
