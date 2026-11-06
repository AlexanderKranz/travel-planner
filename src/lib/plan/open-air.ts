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

/** Out of season in month `m`: climate decides when the month has data, else `winterAt`. */
function monthOutOfSeason(m: number, lat: number | undefined, climate: PlanInputStored["llm"]["climate"]): boolean {
  const c = climate?.find((x) => x.m === m);
  if (c) return c.tmax < OPEN_AIR_MIN_TMAX;
  return lat !== undefined && winterAt(lat, m);
}

/**
 * Is an open-air bath at `lat` out of season on `date`? A trip with months only (no dates) counts as out of season
 * when every selected month is.
 */
export function outOfSeason(
  date: string | null | undefined,
  lat: number | undefined,
  climate: PlanInputStored["llm"]["climate"],
  months?: readonly number[],
): boolean {
  if (date) return monthOutOfSeason(Number(date.slice(5, 7)), lat, climate);
  return !!months?.length && months.every((m) => monthOutOfSeason(m, lat, climate));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Name forms a text may use: "Passauer Erlebnisbad (PEB)" → itself, "Passauer Erlebnisbad", "PEB". Longest first. */
function nameForms(name: string): string[] {
  const out = [name.trim()];
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(name);
  if (m) out.push(m[1].trim(), m[2].trim());
  return [...new Set(out.filter((x) => x.length >= 3))].sort((a, b) => b.length - a.length);
}
/** Preposition, article or connector that belongs to a removed name ("im", "zum", "oder", "at the" ...), de + en. */
const LEAD = String.raw`(?:\s+(?:in das|in der|at the|in the|to the|im|ins|in|zum|zur|am|beim|ans|an|oder|und|at|to|or|and|the))?`;

/**
 * The activity text without a removed place's name: the new ref's name when the ref was swapped, else the name is
 * cut out together with its leading preposition or connector (no new wording, so it works in any language).
 */
export function rewriteRemovedName(text: string, removed: string, replacement: string | undefined): string {
  let out = text;
  for (const form of nameForms(removed)) {
    const word = String.raw`(?<![\p{L}\p{N}])${escapeRe(form)}(?![\p{L}\p{N}])`;
    if (!new RegExp(word, "iu").test(out)) continue;
    out = replacement ? out.replace(new RegExp(word, "giu"), replacement) : out.replace(new RegExp(LEAD + String.raw`\s*` + word, "giu"), "");
    break;
  }
  if (out === text) return text;
  return out
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.;:!?)])/g, "$1")
    .replace(/^\s*[,;:]\s*/, "")
    .replace(/[,;:]\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Removes open-air baths from ref/alts of an indoor activity, or when out of season on `date` (or in every selected
 * month of a trip without dates); `dropped` counts removed keys. A text that names a removed place gets the new
 * ref's name (ref swapped) or loses the name; `act` is null when nothing of the text is left.
 */
export function guardOpenAir(
  a: PlanActivity,
  c: PlaceClass,
  date: string | null | undefined,
  climate: PlanInputStored["llm"]["climate"],
  months?: readonly number[],
): { act: PlanActivity | null; dropped: number } {
  if (!a.ref) return { act: a, dropped: 0 };
  const indoor = INDOOR_TEXT.test(a.text) || c.group.get(a.ref) === "indoor" || c.category.get(a.ref) === "leisure=indoor_play";
  const keys = [a.ref, ...(a.alts ?? [])];
  const isRemoved = (k: string) => isOpenAirPlace(k, c) && (indoor || outOfSeason(date, c.lat.get(k), climate, months));
  const kept = keys.filter((k) => !isRemoved(k)) as OsmKey[];
  const dropped = keys.length - kept.length;
  if (!dropped) return { act: a, dropped: 0 };
  const act: PlanActivity = { ...a };
  delete act.ref;
  delete act.alts;
  if (kept.length) {
    act.ref = kept[0];
    if (kept.length > 1) act.alts = kept.slice(1);
  }
  const swapped = act.ref !== a.ref ? act.ref : undefined;
  for (const k of keys.filter(isRemoved)) {
    const name = c.name.get(k);
    // Only the old ref is replaced by the new one; a removed alternative's name is cut out.
    if (name) act.text = rewriteRemovedName(act.text, name, k === a.ref && swapped ? c.name.get(swapped) : undefined);
  }
  return { act: act.text ? act : null, dropped };
}
