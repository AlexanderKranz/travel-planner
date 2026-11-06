/**
 * Open-air pools as indoor options (issue #142). Family-interest places carry no `g` in the model input (adding it
 * would change the prompt and the input hash), so the model offered a Freibad as the alternative for "Spielen mit
 * Kleinkind, drinnen" in December. Code knows the classification (index `g`, activity places' `g`) and removes an
 * open-air bath from `ref` and `alts` when the activity is indoor (indoor wording, or an indoor ref) or the day is
 * out of season: climate month tmax below OPEN_AIR_MIN_TMAX, or without climate data the local winter months at
 * the bath's latitude (`outOfSeason`). A removed ref is replaced by the first remaining alternative.
 */
import type { OsmKey, PlanActivity } from "@/lib/domain/plan";
import { BATH_CATEGORIES, isOpenAirBath, type ActivityGroup } from "@/lib/facts/activity-types";
import type { PlanInputStored } from "./input";

/** Monthly mean daily maximum (°C) below which no open-air pool is offered (Central European outdoor pools open
 * from about May, tmax ~19 °C, to September). */
export const OPEN_AIR_MIN_TMAX = 18;

/** Wording that makes an activity indoor or bad-weather (de + en). */
export const INDOOR_TEXT = /drinnen|indoor|\bhallen?|überdacht|bei regen|schlechtwetter|regentag|inside|rainy|if it rains|in the rain/i;

export type PlaceClass = {
  group: Map<string, ActivityGroup>;
  category: Map<string, string>;
  name: Map<string, string>;
  lat: Map<string, number>;
};

/** OSM key → indoor/outdoor (index `g`, then activity places' `g`) and category, from the stored input. */
export function placeClasses(stored: Pick<PlanInputStored, "index" | "llm">): PlaceClass {
  const group = new Map<string, ActivityGroup>();
  const category = new Map<string, string>();
  const name = new Map<string, string>();
  const lat = new Map<string, number>();
  const actG = new Map((stored.llm.activities?.places ?? []).map((p) => [p.id, p.g as ActivityGroup]));
  for (const [id, e] of Object.entries(stored.index)) {
    category.set(e.key, e.place.category);
    name.set(e.key, e.place.name);
    lat.set(e.key, e.place.lat);
    const g = e.g ?? actG.get(id);
    if (g) group.set(e.key, g);
  }
  return { group, category, name, lat };
}

/** A bath whose classification is outdoor (old stored inputs without `g`: by name). */
export function isOpenAirPlace(key: string, c: PlaceClass): boolean {
  const cat = c.category.get(key);
  if (!cat || !BATH_CATEGORIES.has(cat)) return false;
  const g = c.group.get(key);
  return g ? g === "outdoor" : isOpenAirBath({ name: c.name.get(key) ?? "" });
}

/**
 * Open-air pool season without climate data: never in the local winter months at latitudes of 35° and more
 * (north: Nov-Mar, south: May-Sep), and from 45° also not in the shoulder months (Oct, Apr). Below 35° unknown.
 */
export function winterAt(lat: number, month: number): boolean {
  const abs = Math.abs(lat);
  if (abs < 35) return false;
  const winter = lat >= 0 ? [11, 12, 1, 2, 3] : [5, 6, 7, 8, 9];
  return winter.includes(month) || (abs >= 45 && (month === 10 || month === 4));
}

/** Is an open-air bath at `lat` out of season on `date`? Climate decides when the month has data, else `winterAt`. */
export function outOfSeason(date: string | null | undefined, lat: number | undefined, climate: PlanInputStored["llm"]["climate"]): boolean {
  if (!date) return false;
  const m = Number(date.slice(5, 7));
  const c = climate?.find((x) => x.m === m);
  if (c) return c.tmax < OPEN_AIR_MIN_TMAX;
  return lat !== undefined && winterAt(lat, m);
}

/**
 * Removes open-air baths from ref/alts of an indoor activity, or when out of season on `date`; `dropped` counts
 * removed keys.
 */
export function guardOpenAir(
  a: PlanActivity,
  c: PlaceClass,
  date: string | null | undefined,
  climate: PlanInputStored["llm"]["climate"],
): { act: PlanActivity; dropped: number } {
  if (!a.ref) return { act: a, dropped: 0 };
  const indoor = INDOOR_TEXT.test(a.text) || c.group.get(a.ref) === "indoor" || c.category.get(a.ref) === "leisure=indoor_play";
  const keys = [a.ref, ...(a.alts ?? [])];
  const kept = keys.filter((k) => !(isOpenAirPlace(k, c) && (indoor || outOfSeason(date, c.lat.get(k), climate)))) as OsmKey[];
  const dropped = keys.length - kept.length;
  if (!dropped) return { act: a, dropped: 0 };
  const act: PlanActivity = { ...a };
  delete act.ref;
  delete act.alts;
  if (kept.length) {
    act.ref = kept[0];
    if (kept.length > 1) act.alts = kept.slice(1);
  }
  return { act, dropped };
}
