import type { OsmKey } from "@/lib/domain/plan";
import type { Locale } from "@/lib/domain/profile";
import type { TourInput, TourMode, TourPoint, TourResult } from "@/lib/domain/tour";
import { SLOT_TITLE_MAX, type FixedSlot } from "./fixed-items";

/**
 * City tours in the trip plan (docs/specs/city-tour.md section 10 [T16]). Pure.
 * A tour linked to a day of the trip is rendered by code into that day (web, share page, PDF) at render time, like the
 * fixed items of timed-items [D7]. A linked tour with a start time and a computed result also enters `INPUT.fixed` as
 * an `activity` slot, so rule 13 and the overlap guard keep its time free (no prompt change). Its OSM stops feed the
 * duplicate guard of `assembleDay`.
 */

/** What the plan code needs of a stored tour (a `Tour` fits). */
export type LinkedTour = {
  id: string;
  tripDay: number | null;
  title: string | null;
  input: TourInput;
  result: TourResult | null;
  updatedAt: string;
};

/** Props of the route sketch (`src/components/tour/route-sketch.tsx`, react-pdf in the PDF). */
export type TourSketch = {
  legs: { poly: string | null; dashed?: boolean }[];
  points: { lat: number; lon: number; n?: number }[];
};

/** One tour block of a day card. */
export type TourBlock = {
  id: string;
  day: number;
  /** Start time (`input.startTime`); null = no start time (the block goes to the top of the day). */
  from: string | null;
  /** from + total minutes of the stored result; null without a start time or a result with a total. */
  to: string | null;
  /** The user's own title; null = none (the UI then shows only "Stadttour"). */
  title: string | null;
  /** Stop names in visiting order (start first; a round trip ends with the start again). */
  stops: string[];
  /** Number of places (without start and end), "5 Orte". */
  placeCount: number;
  /** Total distance in km over all legs; null when a leg has none or there is no result. */
  km: number | null;
  mode: TourMode;
  sketch: TourSketch | null;
  /** Start or end is a Geoapify address result (no OSM POI): the share box says these are visible. */
  addressEnds: boolean;
};

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => {
  const x = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
};

/** "10:00" + 220 min → "13:40"; past midnight wraps ("ends the next day", timed-items [D2]). */
export const addMinutes = (from: string, min: number): string => hhmm(toMin(from) + min);

/** Is the tour's day a day of the trip? Tours without one or beyond the trip length go under "Ohne Tag". */
export const onTripDay = (t: Pick<LinkedTour, "tripDay">, lengthDays: number): t is { tripDay: number } =>
  t.tripDay !== null && Number.isInteger(t.tripDay) && t.tripDay >= 1 && t.tripDay <= lengthDays;

/** Every point of the tour by key: places, start, end (the city is no stop). */
function pointsByKey(i: TourInput): Map<string, TourPoint> {
  const out = new Map<string, TourPoint>();
  if (i.start) out.set(i.start.key, i.start);
  for (const p of i.places) out.set(p.key, p);
  if (typeof i.end === "object") out.set(i.end.key, i.end);
  return out;
}

/** Input order: start, places, end (the start again for a round trip). */
function inputOrder(i: TourInput): string[] {
  const keys = [...(i.start ? [i.start.key] : []), ...i.places.map((p) => p.key)];
  if (i.end === "start" && i.start) keys.push(i.start.key);
  else if (typeof i.end === "object") keys.push(i.end.key);
  return keys;
}

/**
 * Visiting order: the stored result's order when it covers exactly the input's points, else the input order (a result
 * computed for an earlier input may name removed places or miss added ones).
 */
export function visitOrder(i: TourInput, result: TourResult | null): TourPoint[] {
  const byKey = pointsByKey(i);
  // The stored order must name exactly the current points: a place added since the computation is in no result.
  const fits = !!result?.order.length && result.order.every((k) => byKey.has(k)) && [...byKey.keys()].every((k) => result.order.includes(k));
  const order = fits ? result.order : inputOrder(i);
  return order.map((k) => byKey.get(k)!);
}

/** Total km of the result's legs (1 decimal); null when any leg has no distance. */
export function tourKm(result: TourResult | null): number | null {
  if (!result?.legs.length || result.legs.some((l) => l.km === null)) return null;
  return Math.round(result.legs.reduce((s, l) => s + (l.km ?? 0), 0) * 10) / 10;
}

/** Sketch data from the snapshot: leg polylines (dashed for a per-leg mode) and the numbered stops. */
export function tourSketch(i: TourInput, result: TourResult | null): TourSketch | null {
  if (!result?.legs.some((l) => l.poly)) return null;
  const seen = new Set<string>();
  const points: TourSketch["points"] = [];
  for (const p of visitOrder(i, result)) {
    if (seen.has(p.key)) continue; // the round trip's end is the start
    seen.add(p.key);
    points.push({ lat: p.lat, lon: p.lon, n: points.length + 1 });
  }
  return { legs: result.legs.map((l) => (l.mode !== i.mode ? { poly: l.poly, dashed: true } : { poly: l.poly })), points };
}

const isAddress = (p: TourPoint | undefined) => !!p && p.source === "geoapify" && p.key.startsWith("gfy:");

/** Does the tour start or end at a Geoapify address result (no OSM POI)? */
export const hasAddressEnds = (i: TourInput): boolean => isAddress(i.start) || (typeof i.end === "object" && isAddress(i.end));

/** The day block of a linked tour, or null when it has no day within the trip. */
export function tourBlockOf(t: LinkedTour, lengthDays: number): TourBlock | null {
  return onTripDay(t, lengthDays) ? blockOf(t, t.tripDay) : null;
}

/** The block of a tour without a day of the trip ("Ohne Tag" list): `day` is 0. */
export const noDayBlockOf = (t: LinkedTour): TourBlock => blockOf(t, 0);

function blockOf(t: LinkedTour, day: number): TourBlock {
  const from = t.input.startTime ?? null;
  const total = t.result?.totalMin ?? null;
  return {
    id: t.id,
    day,
    from,
    to: from && total !== null && total > 0 ? addMinutes(from, total) : null,
    title: t.title,
    stops: visitOrder(t.input, t.result).map((p) => p.name),
    placeCount: t.input.places.length,
    km: tourKm(t.result),
    mode: t.input.mode,
    sketch: tourSketch(t.input, t.result),
    addressEnds: hasAddressEnds(t.input),
  };
}

/** Blocks of all tours on a day of the trip, by day then start (untimed first, as they go to the top), then id. */
export function tourBlocks(tours: readonly LinkedTour[], lengthDays: number): TourBlock[] {
  return tours
    .flatMap((t) => {
      const b = tourBlockOf(t, lengthDays);
      return b ? [b] : [];
    })
    .sort((a, b) => a.day - b.day || (a.from ?? "").localeCompare(b.from ?? "") || a.id.localeCompare(b.id));
}

/** Linked tours that are not on a day of the trip (no day, or beyond the trip length): "Ohne Tag". */
export const toursWithoutDay = <T extends Pick<LinkedTour, "tripDay">>(tours: readonly T[], lengthDays: number): T[] =>
  tours.filter((t) => !onTripDay(t, lengthDays));

/** Model input, not UI text (ground rule 5 covers the UI): the plan's language decides, like the rest of the input. */
const SLOT_PREFIX: Record<Locale, string> = { de: "Stadttour", en: "City tour" };

/** "Stadttour: Stephansdom, Hofburg, …", at most SLOT_TITLE_MAX characters (the item title cut). */
export function tourSlotTitle(i: TourInput, result: TourResult | null, lang: Locale): string {
  const places = new Set(i.places.map((p) => p.key));
  const names = visitOrder(i, result).filter((p) => places.has(p.key)).map((p) => p.name);
  const full = `${SLOT_PREFIX[lang]}: ${names.join(", ")}`;
  return full.length <= SLOT_TITLE_MAX ? full : `${full.slice(0, SLOT_TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * Fixed slots of the tours (spec 10): a tour on a day of the trip with a start time and a result with a total enters
 * as `{ day, from, to, cat: "activity", title }`. Tours without a start time are shown but not sent.
 */
export function tourSlots(tours: readonly LinkedTour[], lengthDays: number, lang: Locale): FixedSlot[] {
  const out: FixedSlot[] = [];
  for (const t of tours) {
    const b = tourBlockOf(t, lengthDays);
    if (!b?.from || !b.to) continue;
    out.push({ day: b.day, from: b.from, to: b.to, cat: "activity", title: tourSlotTitle(t.input, t.result, lang) });
  }
  return out.sort((a, b) => a.day - b.day || a.from.localeCompare(b.from) || (a.title ?? "").localeCompare(b.title ?? ""));
}

/**
 * Item slots + tour slots in day/start order. Without tour slots the item slots come back unchanged (same object),
 * so inputs without tours stay byte-identical. The sort is stable: items keep their order among equal starts.
 */
export function withTourSlots(items: FixedSlot[] | undefined, tours: FixedSlot[]): FixedSlot[] | undefined {
  if (!tours.length) return items;
  return [...(items ?? []), ...tours].sort((a, b) => a.day - b.day || a.from.localeCompare(b.from));
}

const OSM_TYPES = { n: "node", w: "way", r: "relation" } as const;

/** Tour key "osm:n123" → plan key "node/123"; null for other keys (GeoNames, Geoapify addresses). */
export function planKeyOf(tourKey: string): OsmKey | null {
  const m = /^osm:([nwr])(\d{1,15})$/.exec(tourKey);
  return m ? (`${OSM_TYPES[m[1] as keyof typeof OSM_TYPES]}/${m[2]}` as OsmKey) : null;
}

/**
 * OSM stops of the tours per trip day (duplicate guard, spec 10). Every tour on a day counts, with or without a start
 * time: its block shows the places on that day either way. Undefined when there are none.
 */
export function tourStopKeys(tours: readonly LinkedTour[], lengthDays: number): Record<string, OsmKey[]> | undefined {
  const out: Record<string, OsmKey[]> = {};
  for (const t of tours) {
    if (!onTripDay(t, lengthDays)) continue;
    const keys = [...pointsByKey(t.input).keys()].flatMap((k) => {
      const p = planKeyOf(k);
      return p ? [p] : [];
    });
    if (!keys.length) continue;
    const day = String(t.tripDay);
    out[day] = [...new Set([...(out[day] ?? []), ...keys])].sort();
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * A tour that enters the plan changed after this version (the "items changed" hint, timed-items [D8]): a tour on a day
 * of the trip with a start time whose `updatedAt` is later. Unlinked or deleted tours are not detected.
 */
export function toursChangedSince(
  tours: readonly Pick<LinkedTour, "tripDay" | "input" | "updatedAt">[],
  lengthDays: number,
  versionAt: string,
): boolean {
  const t0 = Date.parse(versionAt);
  return tours.some((t) => onTripDay(t, lengthDays) && !!t.input.startTime && Date.parse(t.updatedAt) > t0);
}
