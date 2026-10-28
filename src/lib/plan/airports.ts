import { notImplemented } from "./not-implemented";

export type GatewayAirport = { iata: string; name: string; lat: number; lon: number; km: number };

/** The 2 nearest airports of `src/data/airports.json` within 150 km of the anchor (spec 3.2, [D10]). */
export function gatewayAirports(anchor: { lat: number; lon: number }): GatewayAirport[] {
  void anchor;
  return notImplemented("gatewayAirports");
}
