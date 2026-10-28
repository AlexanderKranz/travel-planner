import raw from "@/data/airports.json";
import { haversineKm } from "@/lib/facts/places";

export type GatewayAirport = { iata: string; name: string; lat: number; lon: number; km: number };

export const GATEWAY_MAX_KM = 150;
export const GATEWAY_COUNT = 2;

type Tuple = [string, string, string, string, number, number];
const airports = (raw as unknown as { airports: Tuple[] }).airports;

/** The 2 nearest airports of `src/data/airports.json` within 150 km of the anchor (spec 3.2, [D10]). */
export function gatewayAirports(anchor: { lat: number; lon: number }): GatewayAirport[] {
  const out: GatewayAirport[] = [];
  for (const [iata, name, , , lat, lon] of airports) {
    const km = haversineKm(anchor, { lat, lon });
    if (km <= GATEWAY_MAX_KM) out.push({ iata, name, lat, lon, km: Math.round(km * 10) / 10 });
  }
  return out.sort((a, b) => a.km - b.km || a.iata.localeCompare(b.iata)).slice(0, GATEWAY_COUNT);
}

/** Straight-line km from a point to the nearest gateway, rounded to whole km; undefined without gateways. */
export function nearestGatewayKm(p: { lat: number; lon: number }, gateways: GatewayAirport[]): number | undefined {
  if (!gateways.length) return undefined;
  return Math.round(Math.min(...gateways.map((g) => haversineKm(p, g))));
}
