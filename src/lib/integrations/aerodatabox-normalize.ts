/**
 * AeroDataBox response normalizers (pure, no I/O, fixture-tested). Raw shapes are validated loosely with Zod,
 * then reduced to compact domain types that are safe to cache (a raw FRA FIDS day is 300 KB, normalized ~40 KB).
 * Docs: https://doc.aerodatabox.com (OpenAPI spec openapi-rapidapi-v1.json), checked 2026-10-28.
 */
import { z } from "zod";

export type FidsLeg = {
  number: string; // "LH 1148" as delivered (marketing carrier prefix + digits)
  airlineIata?: string;
  airlineName?: string;
  operatorIata?: string; // only when the API's airline differs from the number prefix
  to: string; // arrival airport IATA
  depLocal: string; // "YYYY-MM-DD HH:MM" at the origin
  depUtc: string; // "YYYY-MM-DDTHH:MMZ"
  arrLocal?: string;
  arrUtc?: string;
};
export type RouteStat = { to: string; perDay: number; operators: { iata?: string; name: string }[] };

export const FidsLegSchema = z.object({
  number: z.string(),
  airlineIata: z.string().optional(),
  airlineName: z.string().optional(),
  operatorIata: z.string().optional(),
  to: z.string(),
  depLocal: z.string(),
  depUtc: z.string(),
  arrLocal: z.string().optional(),
  arrUtc: z.string().optional(),
});
export const RouteStatSchema = z.object({
  to: z.string(),
  perDay: z.number(),
  operators: z.array(z.object({ iata: z.string().optional(), name: z.string() })),
});
export const IsoDateList = z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

const time = z.object({ utc: z.string().optional(), local: z.string().optional() }).passthrough();
const rawFlight = z
  .object({
    departure: z.object({ scheduledTime: time.optional() }).passthrough().optional(),
    arrival: z
      .object({
        airport: z.object({ iata: z.string().optional() }).passthrough().optional(),
        scheduledTime: time.optional(),
      })
      .passthrough()
      .optional(),
    number: z.string().optional(),
    isCargo: z.boolean().optional(),
    airline: z.object({ name: z.string().optional(), iata: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
const rawFids = z.object({ departures: z.array(rawFlight).default([]) }).passthrough();

const rawRoutes = z.object({
  routes: z.array(
    z
      .object({
        destination: z.object({ iata: z.string().optional() }).passthrough(),
        averageDailyFlights: z.number(),
        operators: z.array(z.object({ name: z.string().optional(), iata: z.string().optional() }).passthrough()).default([]),
      })
      .passthrough(),
  ),
});

/** "2027-03-06 09:20+01:00" -> "2027-03-06 09:20". */
function localTime(s: string | undefined): string | undefined {
  const m = s?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : undefined;
}
/** "2027-03-06 08:20Z" -> "2027-03-06T08:20Z". */
function utcTime(s: string | undefined): string | undefined {
  const m = s?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}Z` : undefined;
}

/**
 * Departures of one airport/window -> compact legs for ALL destinations. Dropped: cargo, entries without a
 * flight number, arrival IATA or departure time (cannot be shown or matched). The airline name is kept as
 * delivered ("Flight Alaska" appears for unknown carriers); build.ts resolves names from the number prefix.
 */
export function normalizeFids(body: unknown): FidsLeg[] {
  const out: FidsLeg[] = [];
  for (const f of rawFids.parse(body).departures) {
    const to = f.arrival?.airport?.iata;
    const number = f.number?.trim().replace(/\s+/g, " ");
    const depLocal = localTime(f.departure?.scheduledTime?.local);
    const depUtc = utcTime(f.departure?.scheduledTime?.utc);
    if (f.isCargo || !to || !/^[A-Z]{3}$/.test(to) || !number || !depLocal || !depUtc) continue;
    const prefix = number.replace(/\s/g, "").slice(0, 2);
    const leg: FidsLeg = { number, to, depLocal, depUtc };
    if (f.airline?.iata) leg.airlineIata = f.airline.iata;
    if (f.airline?.name) leg.airlineName = f.airline.name;
    if (f.airline?.iata && f.airline.iata !== prefix) leg.operatorIata = f.airline.iata;
    const arrLocal = localTime(f.arrival?.scheduledTime?.local);
    const arrUtc = utcTime(f.arrival?.scheduledTime?.utc);
    if (arrLocal) leg.arrLocal = arrLocal;
    if (arrUtc) leg.arrUtc = arrUtc;
    out.push(leg);
  }
  return out;
}

/** routes/daily -> destinations with the 7-day average; operators without IATA and the "Flight Alaska" placeholder dropped. */
export function normalizeRoutes(body: unknown): RouteStat[] {
  const out: RouteStat[] = [];
  for (const r of rawRoutes.parse(body).routes) {
    const to = r.destination.iata;
    if (!to || !/^[A-Z]{3}$/.test(to)) continue;
    const operators = r.operators
      .filter((o) => o.name && !(o.name === "Flight Alaska" && !o.iata))
      .map((o) => (o.iata ? { iata: o.iata, name: o.name! } : { name: o.name! }));
    out.push({ to, perDay: Math.round(r.averageDailyFlights * 100) / 100, operators });
  }
  return out;
}

/** flights/number/{n}/dates -> sorted ISO dates. */
export function normalizeFlightDates(body: unknown): string[] {
  return [...IsoDateList.parse(body)].sort();
}
