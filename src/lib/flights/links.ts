export type FlightLinkArgs = {
  from: string; to: string; out: string; back: string; adults: number; locale: "de" | "en"; airlineIata?: string;
};
export type FlightLinks = { google: string; skyscanner: string; airline?: string };

/** Deep links without prices (spec section 2.3). Stub: integrations-dev implements. */
export function flightLinks(_a: FlightLinkArgs): FlightLinks {
  return { google: "https://www.google.com/travel/flights", skyscanner: "https://www.skyscanner.net" };
}
