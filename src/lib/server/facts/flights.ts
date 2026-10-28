import "server-only";
import { z } from "zod";
import type { Fact, FactsCtx } from "@/lib/domain/facts";
import type { FlightsFacts } from "@/lib/domain/flights";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import { buildFlightsFacts, compactNumber, type BuildFlightsInput, type Lookup } from "@/lib/flights/build";
import { maxBlockMinutes } from "@/lib/flights/constraint";
import { TRIP_UNIT_CAP, flightDates, lookupTtlSeconds, routesSampleDate } from "@/lib/flights/lookups";
import {
  FidsLegSchema,
  IsoDateList,
  RouteStatSchema,
  type FidsLeg,
  type RouteStat,
} from "@/lib/integrations/aerodatabox-normalize";
import { UNITS, aeroDataBoxEnabled, fetchDepartures, fetchFlightDates, fetchRoutesDaily } from "@/lib/integrations/aerodatabox";
import { gatewayAirports } from "@/lib/plan/airports";
import { cacheKey, cached, type CachedResult } from "../api-cache";
import { geoDestination, unavailable } from "./common";

const SOURCE = "aerodatabox" as const;
const DEFAULT_BUDGET_MS = 25_000;
const MAX_ORIGINS = 2;

/** One trip's lookups: shared budget, unit cap and bookkeeping for the fact's fetchedAt/stale/quotaLimited. */
export class Session {
  spent = 0;
  quotaLimited = false;
  stale = false;
  oldest: string | null = null;
  constructor(readonly ctx: FactsCtx, readonly deadline: number, readonly cap: number = TRIP_UNIT_CAP) {}

  async run<T>(cost: number, call: () => Promise<CachedResult<T>>): Promise<T | null> {
    if (Date.now() >= this.deadline || this.spent + cost > this.cap) return null;
    const r = await call();
    if (!r.ok) {
      if (r.error === "quota_exhausted") this.quotaLimited = true;
      else this.spent += cost; // failed requests are charged too
      return null;
    }
    if (r.cache === "miss" || r.cache === "stale") this.spent += cost;
    if (r.stale) this.stale = true;
    if (!this.oldest || r.fetchedAt < this.oldest) this.oldest = r.fetchedAt;
    return r.data;
  }
}

function routes(s: Session, a: string, date: string): Promise<RouteStat[] | null> {
  return s.run(UNITS.routes, () =>
    cached({
      provider: "aerodatabox",
      endpoint: "routes_daily",
      key: cacheKey("routes_daily", 1, { a, d: date }),
      ttlSeconds: lookupTtlSeconds("routes_daily", date, s.ctx.today),
      schema: z.array(RouteStatSchema),
      fetcher: () => fetchRoutesDaily(a, date),
      ctx: s.ctx,
    }),
  );
}

export async function departures(s: Session, a: string, date: string): Promise<Lookup<FidsLeg[]>> {
  const parts: FidsLeg[][] = [];
  for (const w of ["am", "pm"] as const) {
    const part = await s.run(UNITS.fids, () =>
      cached({
        provider: "aerodatabox",
        endpoint: "fids_departures",
        key: cacheKey("fids_departures", 1, { a, d: date, w }),
        ttlSeconds: lookupTtlSeconds("fids_departures", date, s.ctx.today),
        schema: z.array(FidsLegSchema),
        fetcher: () => fetchDepartures(a, date, w),
        ctx: s.ctx,
      }),
    );
    if (part) parts.push(part);
  }
  return parts.length ? { data: parts.flat(), complete: parts.length === 2 } : null;
}

function flightDays(s: Session, number: string, month: string): Promise<string[] | null> {
  return s.run(UNITS.dates, () =>
    cached({
      provider: "aerodatabox",
      endpoint: "flight_dates",
      key: cacheKey("flight_dates", 1, { n: number, m: month }),
      ttlSeconds: lookupTtlSeconds("flight_dates", `${month}-01`, s.ctx.today),
      schema: IsoDateList,
      fetcher: () => fetchFlightDates(number, month),
      ctx: s.ctx,
    }),
  );
}

/** Direct routes origin x gateway for the trip's dates or a sample week. Never throws. */
export async function getFlightsFacts(
  trip: Trip,
  a: { homeAirports: string[]; purpose: TripPurpose | null; ctx: FactsCtx; budgetMs?: number },
): Promise<Fact<FlightsFacts>> {
  try {
    if (!aeroDataBoxEnabled()) return unavailable("disabled", SOURCE);
    const own = trip.originAirports.length ? trip.originAirports : a.homeAirports;
    const origins = [...new Set(own.map((x) => x.toUpperCase()))].slice(0, MAX_ORIGINS);
    if (!origins.length) return unavailable("no_origin", SOURCE);
    const geo = geoDestination(trip);
    if (!geo) return unavailable("no_location", SOURCE);
    const dates = flightDates(trip, a.ctx.today);
    if (!dates) return unavailable("no_dates", SOURCE);

    const gateways = gatewayAirports(geo).map(({ iata, name, km }) => ({ iata, name, km }));
    const s = new Session(a.ctx, Date.now() + (a.budgetMs ?? DEFAULT_BUDGET_MS));
    const input: BuildFlightsInput = {
      today: a.ctx.today,
      dates,
      origins,
      gateways,
      maxBlockMin: maxBlockMinutes(a.purpose),
      routes: {},
      departures: { out: {}, back: {} },
      flightDates: {},
      quotaLimited: false,
    };

    if (gateways.length) {
      const sample = routesSampleDate(dates.checked.out);
      for (const o of origins) {
        const stats = await routes(s, o, sample);
        input.routes[o] = stats ? { data: stats, complete: true } : null;
      }
      const serves = (o: string, g: string) => {
        const r = input.routes[o];
        return r === null || r === undefined || r.data.some((x) => x.to === g);
      };
      for (const o of origins) {
        if (gateways.some((g) => serves(o, g.iata))) input.departures.out[o] = await departures(s, o, dates.checked.out);
      }
      for (const g of gateways) {
        if (origins.some((o) => serves(o, g.iata))) input.departures.back[g.iata] = await departures(s, g.iata, dates.checked.back);
      }

      // Step N: weekday pattern for the first outbound and first return leg (schedule mode only).
      const first = buildFlightsFacts(input);
      for (const dir of ["out", "back"] as const) {
        if (dates.mode[dir] === "proxy") continue;
        const leg = first.legs.find((l) => l.dir === dir && !l.tooLong);
        const n = leg && compactNumber(leg.number);
        if (!leg || !n) continue;
        const days = await flightDays(s, n, leg.date.slice(0, 7));
        if (days) input.flightDates[n] = days;
      }
    }

    input.quotaLimited = s.quotaLimited;
    const data = buildFlightsFacts(input);
    return {
      status: "ok",
      data,
      source: SOURCE,
      sourceUrl: "https://aerodatabox.com",
      fetchedAt: s.oldest ?? new Date().toISOString(),
      stale: s.stale,
    };
  } catch (error) {
    console.error("getFlightsFacts failed", error instanceof Error ? error.name : "unknown");
    return unavailable("provider_error", SOURCE);
  }
}
