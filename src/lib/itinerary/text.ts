/**
 * Shared token rules of the itinerary prefilter, parser and AI normalizer (docs/specs/itinerary-upload.md section 3).
 * Pure, browser and server. German and English.
 */

const MARKS = /\p{M}+/gu;

/** Lower case without diacritics, same length as the NFC input (positions stay valid for slicing). */
export function matchKey(nfc: string): string {
  const key = nfc.normalize("NFD").replace(MARKS, "").toLowerCase();
  return key.length === nfc.length ? key : nfc.toLowerCase();
}

/** Case- and diacritic-folded, NFC, ß = ss, punctuation as spaces, whitespace collapsed (source checks). */
export function foldText(s: string): string {
  return s
    .normalize("NFD")
    .replace(MARKS, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const MONTHS: Record<string, number> = {
  jan: 1, januar: 1, january: 1, janner: 1,
  feb: 2, februar: 2, february: 2,
  mar: 3, marz: 3, march: 3, maerz: 3,
  apr: 4, april: 4,
  mai: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, november: 11,
  dez: 12, dec: 12, dezember: 12, december: 12,
};
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

/** Weekday names and abbreviations, de + en (matched on `matchKey` text). */
export const WEEKDAY_FULL = /\b(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend|sonntag|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;
const WEEKDAY_ANY =
  "montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend|sonntag|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|mo|di|mi|do|fr|sa|so";

/** A date found in a line. `year` null = not printed. Month and day are range-checked. */
export type DateHit = { start: number; end: number; year: number | null; month: number; day: number };

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validDate(year: number | null, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) return false;
  if (year === null) return true;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

const fullYear = (y: string | undefined): number | null => {
  if (!y) return null;
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
};

type DateRule = { re: RegExp; read: (m: RegExpExecArray) => { year: number | null; month: number; day: number } };

const DATE_RULES: DateRule[] = [
  // 2037-12-19
  { re: /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g, read: (m) => ({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }) },
  // 19.12.2037, 19.12.37, 19.12., 19. 12.
  {
    re: /(?<![\d.])(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}|\d{2})(?![\d:.]))?/g,
    read: (m) => ({ year: fullYear(m[3]), month: Number(m[2]), day: Number(m[1]) }),
  },
  // 19. Dez 2037, 19 December, 19th Dec
  {
    re: new RegExp(`(?<![\\d.])(\\d{1,2})(?:\\.|st|nd|rd|th)?\\s*(${MONTH_ALT})(?![a-z])\\.?(?:,?\\s+(\\d{4})(?!\\d))?`, "g"),
    read: (m) => ({ year: fullYear(m[3]), month: MONTHS[m[2]], day: Number(m[1]) }),
  },
  // Dec 19, December 19th, 2037
  {
    re: new RegExp(`(?<![a-z])(${MONTH_ALT})(?![a-z])\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:.]\\d)(?:,?\\s+(\\d{4})(?!\\d))?`, "g"),
    read: (m) => ({ year: fullYear(m[3]), month: MONTHS[m[1]], day: Number(m[2]) }),
  },
  // 19/12/2037 only when unambiguous (day > 12), else US/EU order is unknown
  {
    re: /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/g,
    read: (m) => {
      const a = Number(m[1]);
      const b = Number(m[2]);
      return a > 12 ? { year: Number(m[3]), month: b, day: a } : b > 12 ? { year: Number(m[3]), month: a, day: b } : { year: null, month: 0, day: 0 };
    },
  },
];

/** The first valid date of a line (`key` = matchKey of the line). */
export function findDate(key: string): DateHit | null {
  let best: DateHit | null = null;
  for (const rule of DATE_RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(key); m; m = rule.re.exec(key)) {
      const { year, month, day } = rule.read(m);
      if (!validDate(year, month, day)) continue;
      const hit = { start: m.index, end: m.index + m[0].length, year, month, day };
      if (!best || hit.start < best.start || (hit.start === best.start && hit.end > best.end)) best = hit;
      break;
    }
  }
  return best;
}

/** Weekday token right before or after a span (e.g. "Sa 19.12." or "19.12. (Sa)"), to blank it out with the date. */
export function weekdaySpans(key: string, start: number, end: number): [number, number][] {
  const out: [number, number][] = [];
  const before = new RegExp(`(?:^|[\\s,(|])((${WEEKDAY_ANY})\\.?,?\\s*)$`).exec(key.slice(0, start));
  if (before) out.push([start - before[1].length, start]);
  const after = new RegExp(`^(\\s*[,(]?\\s*(${WEEKDAY_ANY})\\.?\\)?)(?![a-z])`).exec(key.slice(end));
  if (after) out.push([end, end + after[1].length]);
  return out;
}

/** "Tag 3", "Day 3", "3. Tag". */
export function findDayNumber(key: string): { start: number; end: number; day: number } | null {
  const m = /\b(?:tag|day)\s*(\d{1,2})(?!\d)\.?/.exec(key) ?? /(?<![\d.])(\d{1,2})\.\s*tag\b/.exec(key);
  if (!m) return null;
  const day = Number(m[1]);
  return day >= 1 ? { start: m.index, end: m.index + m[0].length, day } : null;
}

/** A time found in a line, as HH:MM. */
export type TimeHit = { start: number; end: number; hhmm: string };

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;
const NOT_PRICE = "(?!\\s*(?:€|eur|euro|\\$|usd|chf|gbp|£|,-))";

const TIME_RULES: { re: RegExp; read: (m: RegExpExecArray) => string | null }[] = [
  // 4 pm, 4:30 p.m.
  {
    re: /(?<![\d.:])(1[0-2]|0?\d)(?:[:.]([0-5]\d))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/g,
    read: (m) => {
      const h = Number(m[1]) % 12;
      return hhmm(m[3].startsWith("p") ? h + 12 : h, Number(m[2] ?? 0));
    },
  },
  // 16:00, 7.30, 16.00 Uhr, 16:00h
  {
    re: new RegExp(`(?<![\\d.:])([01]?\\d|2[0-3])[:.]([0-5]\\d)(?![\\d])${NOT_PRICE}(?:\\s*(?:uhr|h)(?![a-z]))?`, "g"),
    read: (m) => hhmm(Number(m[1]), Number(m[2])),
  },
  // 16 Uhr, 16h
  { re: /(?<![\d.:])([01]?\d|2[0-3])\s*(?:uhr|h)(?![a-z])/g, read: (m) => hhmm(Number(m[1]), 0) },
];

/** All times of a line in order (`key` = matchKey). Overlapping hits keep the earlier, longer one. */
export function findTimes(key: string): TimeHit[] {
  const hits: TimeHit[] = [];
  for (const rule of TIME_RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(key); m; m = rule.re.exec(key)) {
      const v = rule.read(m);
      if (v) hits.push({ start: m.index, end: m.index + m[0].length, hhmm: v });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: TimeHit[] = [];
  for (const h of hits) if (!out.some((o) => h.start < o.end && o.start < h.end)) out.push(h);
  return out;
}

/** Colon times that are out of range ("24:00", "25:30"): the line had a time that cannot be read. */
export function findUnclearTimes(key: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = /(?<![\d.:])(\d{1,2}):(\d{2})(?!\d)|\?\?[:.]\?\?|--[:.]--/g;
  for (let m = re.exec(key); m; m = re.exec(key)) {
    if (m[1] !== undefined && Number(m[1]) <= 23 && Number(m[2]) <= 59) continue;
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Sea or river day without a port. */
export const SEA_WORDS = /\b(seetag|auf see|tag auf see|at sea|sea day|day at sea|flusstag|river day|fahrtag)\b/;

export const ARR_WORDS = new Set(["an", "ank", "ankunft", "anlegen", "einlaufen", "arr", "arrive", "arrives", "arrival"]);
export const DEP_WORDS = new Set(["ab", "abf", "abfahrt", "ablegen", "auslaufen", "weiterfahrt", "dep", "depart", "departs", "departure"]);
const GERMAN_MARKERS = new Set(["an", "ank", "ankunft", "anlegen", "einlaufen", "ab", "abf", "abfahrt", "ablegen", "auslaufen", "weiterfahrt"]);
export const isGermanMarker = (w: string) => GERMAN_MARKERS.has(w);

/** Times of day without a clock time ("Ankunft morgens"). */
export const DAYPART_WORDS = new Set([
  "morgens", "fruh", "vormittags", "mittags", "nachmittags", "abends", "nachts",
  "morning", "noon", "afternoon", "evening", "night",
]);

/** Words around a place that are not part of it. */
export const FILLER_WORDS = new Set([
  "in", "im", "um", "at", "nach", "to", "from", "von", "bis", "gegen", "ca", "circa", "etwa", "approx",
  "approximately", "uhr", "h", "hrs", "und", "and", "dann", "then", "the", "der", "die", "das", "den",
]);
