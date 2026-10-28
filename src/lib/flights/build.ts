import raw from "@/data/airports.json";
import type { FlightLeg, FlightPair, FlightsFacts, PairStatus } from "@/lib/domain/flights";
import { haversineKm } from "@/lib/facts/places";
import type { FidsLeg, RouteStat } from "@/lib/integrations/aerodatabox-normalize";
import { AIRLINES } from "./airlines";
import { daysBetween, daysInMonth, isoWeekday, type FlightDates } from "./lookups";

/** A lookup result: `complete` = every window of the day was fetched; null = not checked (refused, failed, no budget). */
export type Lookup<T> = { data: T; complete: boolean } | null;

export type BuildFlightsInput = {
  today: string;
  dates: FlightDates;
  origins: string[];
  gateways: { iata: string; name: string; km: number }[];
  maxBlockMin: number | null;
  /** routes/daily per origin (null = not checked). */
  routes: Record<string, Lookup<RouteStat[]>>;
  /** departures on the checked outbound date per origin / checked return date per gateway. */
  departures: { out: Record<string, Lookup<FidsLeg[]>>; back: Record<string, Lookup<FidsLeg[]>> };
  /** flights/number dates per compact number ("LH1148") for the month of the checked date. */
  flightDates: Record<string, string[]>;
  quotaLimited: boolean;
};

type Tuple = [string, string, string, string, number, number];
const coords = new Map((raw as unknown as { airports: Tuple[] }).airports.map((a) => [a[0], { lat: a[4], lon: a[5] }]));

const MAX_LEGS_PER_DIR = 6;
const NUMBER = /^([A-Z0-9]{2})\s?(\d{1,4}[A-Z]?)$/;
const round5 = (n: number) => Math.round(n / 5) * 5;

export function approxBlockMin(from: string, to: string): number {
  const a = coords.get(from);
  const b = coords.get(to);
  return a && b ? round5(30 + haversineKm(a, b) / 13.3) : 0;
}

const utcMs = (s: string) => Date.parse(s); // "YYYY-MM-DDTHH:MMZ"
const hhmm = (local: string) => local.slice(11, 16);

/** "LH 1148" / "LH1148" -> compact "LH1148" (key for flight-dates lookups), null if invalid. */
export function compactNumber(n: string): string | null {
  const m = NUMBER.exec(n.trim().toUpperCase());
  return m ? `${m[1]}${m[2]}` : null;
}

function airlineOf(prefix: string, l: FidsLeg): string | null {
  return AIRLINES[prefix]?.name ?? (l.airlineIata === prefix && l.airlineName ? l.airlineName : null);
}

/** Convert raw departures of one airport/day into legs for one pair; codeshare duplicates removed. */
export function legsForPair(
  dir: "out" | "back",
  from: string,
  to: string,
  date: string,
  fids: FidsLeg[],
  maxBlockMin: number | null,
): FlightLeg[] {
  const kept = new Map<string, FidsLeg>();
  for (const l of fids) {
    if (l.to !== to) continue;
    const m = NUMBER.exec(l.number.trim().toUpperCase());
    if (!m || !l.arrLocal || !l.arrUtc) continue;
    const key = l.depLocal;
    const prev = kept.get(key);
    // Codeshare duplicates share the departure time; prefer the entry whose number prefix is the operator.
    if (!prev || (!l.operatorIata && prev.operatorIata)) kept.set(key, l);
  }
  const legs: FlightLeg[] = [];
  for (const l of kept.values()) {
    const m = NUMBER.exec(l.number.trim().toUpperCase())!;
    const blockMin = Math.round((utcMs(l.arrUtc!) - utcMs(l.depUtc)) / 60_000);
    if (!(blockMin > 0 && blockMin < 24 * 60)) continue;
    const off = daysBetween(l.depLocal.slice(0, 10), l.arrLocal!.slice(0, 10));
    if (off < 0 || off > 1) continue;
    const leg: FlightLeg = {
      dir, from, to,
      number: `${m[1]} ${m[2]}`,
      airline: airlineOf(m[1], l),
      dep: hhmm(l.depLocal),
      arr: hhmm(l.arrLocal!),
      arrDayOffset: off as 0 | 1,
      blockMin,
      date,
    };
    const op = l.operatorIata && l.operatorIata !== m[1] ? AIRLINES[l.operatorIata]?.name : undefined;
    if (op) leg.operatedBy = op;
    if (maxBlockMin !== null && blockMin > maxBlockMin) leg.tooLong = true;
    legs.push(leg);
  }
  return legs;
}

const byFitThenDep = (a: FlightLeg, b: FlightLeg) =>
  Number(!!a.tooLong) - Number(!!b.tooLong) || a.dep.localeCompare(b.dep) || a.number.localeCompare(b.number);

/** Pure builder: normalized lookups -> FlightsFacts (spec 2.2). */
export function buildFlightsFacts(i: BuildFlightsInput): FlightsFacts {
  const { dates, today } = i;
  const pairs: FlightPair[] = [];
  const outLegs: FlightLeg[] = [];
  const backLegs: FlightLeg[] = [];

  for (const o of i.origins) {
    for (const g of i.gateways) {
      const out = i.departures.out[o] ?? null;
      const back = i.departures.back[g.iata] ?? null;
      const oLegs = out ? legsForPair("out", o, g.iata, dates.checked.out, out.data, i.maxBlockMin) : [];
      const bLegs = back ? legsForPair("back", g.iata, o, dates.checked.back, back.data, i.maxBlockMin) : [];
      outLegs.push(...oLegs);
      backLegs.push(...bLegs);

      const stats = i.routes[o] ?? null;
      const stat = stats?.data.find((r) => r.to === g.iata);
      const unpublished =
        dates.mode.out === "proxy" || dates.mode.back === "proxy" || daysBetween(today, dates.outDate) > 180;
      const absent: PairStatus = unpublished ? "not_published" : "none";
      let status: PairStatus;
      if (oLegs.length + bLegs.length > 0) status = "found";
      else if (stats && !stat) status = absent; // origin does not serve it in the sampled week
      else if (out?.complete && (back === null || back.complete)) status = absent;
      else status = "not_checked";
      const pair: FlightPair = {
        from: o, to: g.iata, toName: g.name, gatewayKm: g.km, status,
        operators: stat?.operators ?? [],
        approxBlockMin: approxBlockMin(o, g.iata),
      };
      if (stat) pair.perDay = Math.round(stat.perDay * 10) / 10;
      pairs.push(pair);
    }
  }
  pairs.sort((a, b) => Number(b.status === "found") - Number(a.status === "found") || a.gatewayKm - b.gatewayKm);

  const finish = (legs: FlightLeg[]): FlightLeg[] => {
    const sorted = legs.sort(byFitThenDep).slice(0, MAX_LEGS_PER_DIR);
    for (const l of sorted) {
      const days = i.flightDates[l.number.replace(" ", "")];
      if (!days?.length) continue;
      const month = l.date.slice(0, 7);
      const inMonth = days.filter((d) => d.startsWith(month));
      l.weekdays = [...new Set(inMonth.map(isoWeekday))].sort((a, b) => a - b);
      l.operatingDays = { days: inMonth.length, of: daysInMonth(month), month };
    }
    return sorted;
  };

  return {
    basis: dates.basis,
    outDate: dates.outDate,
    backDate: dates.backDate,
    mode: dates.mode,
    checkedDates: dates.checked,
    origins: i.origins,
    gateways: i.gateways,
    pairs,
    legs: [...finish(outLegs), ...finish(backLegs)],
    maxBlockMin: i.maxBlockMin,
    quotaLimited: i.quotaLimited,
  };
}
