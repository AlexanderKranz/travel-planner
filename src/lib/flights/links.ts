export type FlightLinkArgs = {
  from: string; to: string; out: string; back: string; adults: number; locale: "de" | "en"; airlineIata?: string;
};
export type FlightLinks = { google: string; skyscanner: string; airline?: string };

import { AIRLINES } from "./airlines";

const yymmdd = (iso: string) => iso.slice(2).replaceAll("-", "");

/** Deep links without prices (spec 2.3). Pure; computed in the UI from the fact, never stored. */
export function flightLinks(a: FlightLinkArgs): FlightLinks {
  const q = encodeURIComponent(`Flights from ${a.from} to ${a.to} on ${a.out} through ${a.back} nonstop`);
  const links: FlightLinks = {
    google: `https://www.google.com/travel/flights?hl=${a.locale}&q=${q}`,
    skyscanner:
      `https://www.skyscanner.${a.locale === "de" ? "de" : "net"}/transport/flights/${a.from.toLowerCase()}/${a.to.toLowerCase()}` +
      `/${yymmdd(a.out)}/${yymmdd(a.back)}/?adultsv2=${Math.max(1, Math.floor(a.adults))}&stops=!oneStop,!twoPlusStops`,
  };
  const url = a.airlineIata ? AIRLINES[a.airlineIata]?.url : undefined;
  if (url) links.airline = url;
  return links;
}
