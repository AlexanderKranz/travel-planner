import "server-only";
import type { Fact, FactsCtx } from "@/lib/domain/facts";
import type { FlightDir, NearbyFlights } from "@/lib/domain/flights";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import type { Lookup } from "@/lib/flights/build";
import { maxBlockMinutes } from "@/lib/flights/constraint";
import { flightDates } from "@/lib/flights/lookups";
import { NEARBY_UNIT_CAP, buildNearbyDays, nearbyTargets } from "@/lib/flights/nearby";
import type { FidsLeg } from "@/lib/integrations/aerodatabox-normalize";
import { aeroDataBoxEnabled } from "@/lib/integrations/aerodatabox";
import { gatewayAirports } from "@/lib/plan/airports";
import { Session, departures } from "./flights";
import { geoDestination, unavailable } from "./common";

const SOURCE = "aerodatabox" as const;
const MAX_ORIGINS = 2;

export type NearbyRequest = { dir: FlightDir; from: string; to: string };

/**
 * Departures on the days before/after the trip date for ONE pair and direction (on demand, <= 8 units cold).
 * Same FIDS cache keys as the main lookup, so days that were looked up before cost nothing. `from`/`to` must be
 * one of the trip's origin x gateway pairs (no arbitrary airports). Not part of the plan or the LLM input. Never throws.
 */
export async function getNearbyFlights(
  trip: Trip,
  req: NearbyRequest,
  a: { homeAirports: string[]; purpose: TripPurpose | null; ctx: FactsCtx; budgetMs?: number },
): Promise<Fact<NearbyFlights> | { status: "invalid" }> {
  try {
    if (!aeroDataBoxEnabled()) return unavailable("disabled", SOURCE);
    const own = trip.originAirports.length ? trip.originAirports : a.homeAirports;
    const origins = [...new Set(own.map((x) => x.toUpperCase()))].slice(0, MAX_ORIGINS);
    const geo = geoDestination(trip);
    if (!origins.length) return unavailable("no_origin", SOURCE);
    if (!geo) return unavailable("no_location", SOURCE);
    const dates = flightDates(trip, a.ctx.today);
    if (!dates) return unavailable("no_dates", SOURCE);
    const gateways = gatewayAirports(geo);
    if (!origins.includes(req.from) || !gateways.some((g) => g.iata === req.to)) return { status: "invalid" };

    const plan = nearbyTargets(dates, req.dir, a.ctx.today);
    if (!plan) return unavailable("no_dates", SOURCE); // sample week: no exact date to look around

    const depart = req.dir === "out" ? req.from : req.to;
    const arrive = req.dir === "out" ? req.to : req.from;
    const s = new Session(a.ctx, Date.now() + (a.budgetMs ?? 25_000), NEARBY_UNIT_CAP);
    const lookups: Record<string, Lookup<FidsLeg[]>> = {};
    for (const t of plan.targets) {
      if (t.checked) lookups[t.date] = await departures(s, depart, t.checked);
    }
    const data: NearbyFlights = {
      dir: req.dir,
      from: req.from,
      to: req.to,
      mode: plan.mode,
      days: buildNearbyDays({ dir: req.dir, depart, arrive, targets: plan.targets, lookups, maxBlockMin: maxBlockMinutes(a.purpose) }),
      quotaLimited: s.quotaLimited,
    };
    return {
      status: "ok",
      data,
      source: SOURCE,
      sourceUrl: "https://aerodatabox.com",
      fetchedAt: s.oldest ?? new Date().toISOString(),
      stale: s.stale,
    };
  } catch (error) {
    console.error("getNearbyFlights failed", error instanceof Error ? error.name : "unknown");
    return unavailable("provider_error", SOURCE);
  }
}
