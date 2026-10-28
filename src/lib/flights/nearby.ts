import type { FlightDir, FlightLeg, FlightMode, NearbyDay } from "@/lib/domain/flights";
import type { FidsLeg } from "@/lib/integrations/aerodatabox-normalize";
import { legsForPair, type Lookup } from "./build";
import { HORIZON_DAYS, addDays, daysBetween, isoWeekday, type FlightDates } from "./lookups";

/** Units one nearby request may spend: two days x one airport x am+pm windows (2 units each). */
export const NEARBY_UNIT_CAP = 8;
export const MAX_LEGS_PER_NEARBY_DAY = 6;

export type NearbyTarget = { offset: -1 | 1; date: string; checked: string | null };

/**
 * Days to look up around the trip date of one direction. `date` is the real calendar day. `checked` is the schedule
 * date to query: the same day in schedule mode, the proxy date shifted by the same offset in proxy mode.
 * Schedule mode: days in the past or beyond the horizon are not checked (`checked: null`), never proxied.
 * Month-only trips use the sample week's dates (the user's main way to look for other days there).
 */
export function nearbyTargets(
  dates: FlightDates,
  dir: FlightDir,
  today: string,
): { mode: FlightMode; targets: NearbyTarget[] } | null {
  const base = dir === "out" ? dates.outDate : dates.backDate;
  const mode = dates.mode[dir];
  const targets = ([-1, 1] as const).map((offset): NearbyTarget => {
    const date = addDays(base, offset);
    if (mode === "proxy") return { offset, date, checked: addDays(dates.checked[dir], offset) };
    const inRange = date >= today && daysBetween(today, date) <= HORIZON_DAYS;
    return { offset, date, checked: inRange ? date : null };
  });
  return { mode, targets };
}

function byFitThenDep(a: FlightLeg, b: FlightLeg): number {
  return Number(!!a.tooLong) - Number(!!b.tooLong) || a.dep.localeCompare(b.dep) || a.number.localeCompare(b.number);
}

/** Pure: departures of the departure airport per target -> days with the legs of one from/to pair, grouped by date. */
export function buildNearbyDays(i: {
  dir: FlightDir;
  depart: string;
  arrive: string;
  targets: NearbyTarget[];
  lookups: Record<string, Lookup<FidsLeg[]>>; // by target.date
  maxBlockMin: number | null;
}): NearbyDay[] {
  return i.targets
    .map((t): NearbyDay => {
      const base = { date: t.date, offset: t.offset, weekday: isoWeekday(t.date) };
      const look = t.checked ? (i.lookups[t.date] ?? null) : null;
      if (!t.checked || !look) return { ...base, legs: [], complete: false, checked: false };
      const legs = legsForPair(i.dir, i.depart, i.arrive, t.checked, look.data, i.maxBlockMin)
        .sort(byFitThenDep)
        .slice(0, MAX_LEGS_PER_NEARBY_DAY);
      return { ...base, legs, complete: look.complete, checked: true };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
