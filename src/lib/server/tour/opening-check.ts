import "server-only";
import OpeningHours from "opening_hours";
import type { TourOpeningIssue } from "@/lib/domain/tour";
import { hhmmToMin, minToHhmm, type StopTime } from "@/lib/tour/timing";

/**
 * Opening-hours checks of a computed tour (docs/specs/city-tour.md 17.1 [P6], 17.4). Server only: `opening_hours`
 * (LGPL-3.0, unmodified npm dependency) never reaches the browser bundle.
 *
 * Input: the raw OSM `opening_hours` tag per stop, as stored with the stop info (fetched on demand, never here), the
 * tour date, and the stop times. Only with a date and a known city time zone (the caller checks). Times are wall-clock
 * times of the tour day; the library reads a Date's local fields, so a local Date built from those fields is exact.
 * Checks only, never a window: a stop closed at its visit start ("closed"), or closing before the visit ends
 * ("closes"). An unparsable tag or an unknown state gives no issue (the raw tag is still shown with the stop info).
 */
export type OpeningInput = { key: string; tag: string; checkedAt: string };

export function openingIssues(a: {
  date: string;
  stops: readonly { key: string; time: StopTime | undefined; dwellMin: number }[];
  hours: ReadonlyMap<string, OpeningInput>;
  place: { lat: number; lon: number; countryCode?: string | null };
}): TourOpeningIssue[] {
  const [y, mo, d] = a.date.split("-").map(Number);
  const at = (min: number) => new Date(y, mo - 1, d, Math.floor(min / 60), min % 60);
  const nominatim = {
    lat: a.place.lat,
    lon: a.place.lon,
    address: { country_code: (a.place.countryCode ?? "").toLowerCase(), state: "" },
  };
  const out: TourOpeningIssue[] = [];
  for (const s of a.stops) {
    const h = a.hours.get(s.key);
    if (!h || !s.time) continue;
    let oh: OpeningHours;
    try {
      oh = new OpeningHours(h.tag, nominatim);
    } catch {
      continue; // not a tag the parser understands: shown raw only
    }
    const begin = hhmmToMin(s.time.arrive) + (s.time.waitMin ?? 0);
    const end = begin + s.dwellMin;
    try {
      const startDate = at(begin);
      if (oh.getUnknown(startDate)) continue;
      if (!oh.getState(startDate)) {
        out.push({ key: s.key, kind: "closed", at: minToHhmm(begin), checkedAt: h.checkedAt });
        continue;
      }
      const change = oh.getNextChange(startDate, at(end));
      if (change && change.getTime() < at(end).getTime()) {
        out.push({ key: s.key, kind: "closes", at: minToHhmm(change.getHours() * 60 + change.getMinutes()), checkedAt: h.checkedAt });
      }
    } catch {
      // evaluation failed for this day (e.g. holiday data missing): no claim
    }
  }
  return out;
}
