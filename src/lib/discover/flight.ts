import { blockMinFromKm, flightRadiusKm, MAX_ORIGINS, NEAR_AIRPORT_KM } from "@/lib/flights/estimate";
import { haversineKm } from "@/lib/facts/places";
import { getAirport } from "@/lib/integrations/airports";
import { gatewayAirports } from "@/lib/plan/airports";

/**
 * Step 2 of the verification (spec section 3): distance from the origin airports to the nearest gateway of the
 * place, no network. The filter here is authoritative; the radius in the LLM input is only a hint.
 */
export type FlightAssessment =
  | { pass: true; flight: { origin: string; gateway: string; minutes: number } | null; nearAirport: boolean }
  | { pass: false };

export type FlightContext = {
  /** Origin IATA codes; at most MAX_ORIGINS are used (the flight check never asks about more). */
  origins: readonly string[];
  /** The active limit in hours; null = no filter (cards still show the estimate). */
  maxHours: number | null;
};

export function assessFlight(anchor: { lat: number; lon: number }, ctx: FlightContext): FlightAssessment {
  const origins = [...new Set(ctx.origins.map((o) => o.toUpperCase()))]
    .slice(0, MAX_ORIGINS)
    .flatMap((iata) => {
      const a = getAirport(iata);
      return a ? [a] : [];
    });
  // No airports: no estimate and no radius, whatever the limit says.
  if (origins.length === 0) return { pass: true, flight: null, nearAirport: false };

  const gateways = gatewayAirports(anchor);
  // No gateway within 150 km: the flight check would have nothing to look up.
  if (gateways.length === 0) return ctx.maxHours !== null ? { pass: false } : { pass: true, flight: null, nearAirport: false };

  let best: { km: number; origin: string; gateway: string } | null = null;
  for (const o of origins) {
    for (const g of gateways) {
      const km = haversineKm(o, g);
      if (!best || km < best.km) best = { km, origin: o.iata, gateway: g.iata };
    }
  }
  if (!best) return { pass: true, flight: null, nearAirport: false };
  if (best.km < NEAR_AIRPORT_KM) return { pass: true, flight: null, nearAirport: true };
  if (ctx.maxHours !== null && best.km > flightRadiusKm(ctx.maxHours)) return { pass: false };
  return {
    pass: true,
    flight: { origin: best.origin, gateway: best.gateway, minutes: Math.round(blockMinFromKm(best.km)) },
    nearAirport: false,
  };
}
