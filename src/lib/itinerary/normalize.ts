import { z } from "zod";
import { ITINERARY_FLAGS, type ItineraryFlag } from "@/lib/domain/itinerary";
import { MAX_TRIP_STOPS } from "@/lib/domain/trip-stops";
import { splitCountrySuffix } from "./country";
import { isValidIso, isValidYearless, type RawStop } from "./map";
import { DAYPART_WORDS, findDate, findDayNumber, findTimes, foldText, matchKey, SEA_WORDS } from "./text";

/**
 * Wire schema of the Haiku `itinerary_extract` call (docs/specs/itinerary-upload.md section 3.4). Every field is
 * required and nullable (optional fields made the constrained decoder emit broken strings, group-text [D4]); no
 * length or format constraints (not grammar-enforced), `normalizeExtract` checks everything.
 */
export const WireItinerary = z.object({
  stops: z.array(
    z.object({
      date: z.string().nullable(),
      day: z.number().nullable(),
      place: z.string().nullable(),
      cc: z.string().nullable(),
      arr: z.string().nullable(),
      dep: z.string().nullable(),
      sea: z.boolean(),
      note: z.string().nullable(),
    }),
  ),
});
export type WireItinerary = z.infer<typeof WireItinerary>;

/** A cached normalized extraction as read back from `itinerary_extracts.stops` (validated like any external data). */
export const StoredRawStops = z
  .array(
    z.object({
      date: z.string().regex(/^(\d{4}|-)-\d{2}-\d{2}$/).optional(),
      day: z.number().int().min(1).max(366).optional(),
      place: z.string().min(1).max(80).optional(),
      cc: z.string().regex(/^[A-Z]{2}$/).optional(),
      arr: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      dep: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      sea: z.literal(true).optional(),
      note: z.string().max(60).optional(),
      flags: z.array(z.enum(ITINERARY_FLAGS)).optional(),
    }),
  )
  .max(MAX_TRIP_STOPS);

/** What normalization removed, as counts (cached in `itinerary_extracts.flags`, never content). */
export type ExtractDrops = { notInSource: number; noPlace: number; invalid: number };
export type NormalizedExtract = { stops: RawStop[]; drops: ExtractDrops };

const MAX_PLACE = 80;
const MAX_NOTE = 60;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** At most `max` characters, cut at the last space when there is one. */
function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return (at > 0 ? cut.slice(0, at) : s.slice(0, max)).trim();
}

/** "7:00", "07.00", "7:00 Uhr" → "07:00"; anything else → null. */
function cleanTime(raw: string | null): string | null | undefined {
  if (raw === null || !raw.trim()) return undefined;
  const m = /^\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*(uhr|h)?\s*$/i.exec(raw);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/** `YYYY-MM-DD` or `--MM-DD` (also "12-19" without the dashes in front); else null. */
function cleanDate(raw: string | null): string | null | undefined {
  if (raw === null || !raw.trim()) return undefined;
  const s = raw.trim();
  if (isValidIso(s)) return s;
  const md = /^-{0,2}(\d{2})-(\d{2})$/.exec(s);
  if (md && isValidYearless(`--${md[1]}-${md[2]}`)) return `--${md[1]}-${md[2]}`;
  return null;
}

/** A date printed in the source: month and day, the year when printed. */
type SourceDate = { year: number | null; md: string };

/**
 * One source line for the not_in_source checks: its folded words, and the dates and day numbers that apply to it
 * (its own, else those of the nearest line above that printed one: "Sa 19.12." / "Passau 16:00").
 */
type SourceLine = { folded: string; words: Set<string>; sea: boolean; dates: SourceDate[]; days: number[] };

/** The source as folded words, its times and its lines, for the not_in_source checks (text path only). */
export type SourceIndex = { folded: string; words: Set<string>; times: Set<string>; lines: SourceLine[] };

const blankSpan = (s: string, start: number, end: number) => s.slice(0, start) + " ".repeat(end - start) + s.slice(end);

/**
 * Every date of a line ("19.12.–23.12.2037" gives both). A missing year comes from the last full date above it, like
 * the parser does ("19.12.2037" ... "20.12."): the first on or after it, at most a year later.
 */
function datesOf(key: string, last: { iso: string | null }): SourceDate[] {
  const out: SourceDate[] = [];
  for (let i = 0; i < 6; i++) {
    const d = findDate(key);
    if (!d) break;
    const md = `${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
    let year = d.year;
    const prev = last.iso;
    if (year === null && prev) {
      const y = Number(prev.slice(0, 4));
      year = [y, y + 1].find((x) => isValidIso(`${x}-${md}`) && `${x}-${md}` >= prev) ?? null;
    }
    if (year !== null) last.iso = `${year}-${md}`;
    out.push({ year, md });
    key = blankSpan(key, d.start, d.end);
  }
  return out;
}

/** "Tag 3", "3. Tag", or a bare leading number of a day-column row ("3 | Melk"). */
function daysOf(key: string): number[] {
  const out: number[] = [];
  const d = findDayNumber(key);
  if (d) out.push(d.day);
  const lead = /^\s*(\d{1,2})\s*[.|:)–—-]?\s*\p{L}/u.exec(key);
  if (lead && Number(lead[1]) >= 1) out.push(Number(lead[1]));
  return out;
}

export function indexSource(text: string): SourceIndex {
  const folded = ` ${foldText(text)} `;
  const times = new Set<string>();
  const lines: SourceLine[] = [];
  let dates: SourceDate[] = [];
  let days: number[] = [];
  const lastFull = { iso: null as string | null };
  for (const line of text.normalize("NFC").split(/\r\n|\r|\n/)) {
    const key = matchKey(line);
    for (const t of findTimes(key)) times.add(t.hhmm);
    // Hours that only get their unit at the end of a range: "7 bis 12 Uhr", "von 15-21 h", "7 to 11 am".
    for (const m of key.matchAll(/(?<![\d.:])(\d{1,2})\s*(?:bis|-|–|to)\s*\d{1,2}(?:[:.]\d{2})?\s*(uhr|h|am|pm)(?![a-z])/g)) {
      const h = Number(m[1]) + (m[2] === "pm" && Number(m[1]) < 12 ? 12 : 0);
      if (h <= 23) times.add(`${String(h).padStart(2, "0")}:00`);
    }
    if (/\b(noon|mittag|mittags)\b/.test(key)) times.add("12:00");
    if (/\b(midnight|mitternacht)\b/.test(key)) times.add("00:00");
    const f = foldText(line);
    if (!f) continue;
    const own = datesOf(key, lastFull);
    if (own.length) dates = own;
    const ownDays = daysOf(key);
    if (ownDays.length) days = ownDays;
    lines.push({ folded: ` ${f} `, words: new Set(f.split(" ")), sea: SEA_WORDS.test(key), dates, days });
  }
  return { folded, words: new Set(folded.trim().split(" ")), times, lines };
}

/**
 * Source lines that print the place: as a folded phrase, or every word of it on that one line ("Wien, Österreich" vs
 * "Wien (Österreich)"). Words from different lines do not count ("New York" from "New Orleans" and "York").
 */
function placeLines(place: string, src: SourceIndex): SourceLine[] {
  const f = foldText(place);
  if (!f) return [];
  const words = f.split(" ");
  return src.lines.filter((l) => l.folded.includes(` ${f} `) || words.every((w) => l.words.has(w)));
}

/** The place occurs within one line of the source. */
export function placeInSource(place: string, src: SourceIndex): boolean {
  return placeLines(place, src).length > 0;
}

/**
 * A model date (`YYYY-MM-DD` or `--MM-DD`) checked against the dates of the stop's lines: null when no line has that
 * month and day (or only with another year); `--MM-DD` when the source has no year for it (the year is then guessed
 * from the trip and flagged `year_guessed`, never taken from the model).
 */
function sourceDate(date: string, lines: readonly SourceLine[]): string | null {
  const year = date.startsWith("--") ? null : Number(date.slice(0, 4));
  const md = date.slice(-5);
  const hits = lines.flatMap((l) => l.dates).filter((d) => d.md === md);
  if (year === null) return hits.length ? date : null;
  if (hits.some((d) => d.year === year)) return date;
  return hits.some((d) => d.year === null) ? `--${md}` : null;
}

const GERMAN_DAYPARTS = new Set(["morgens", "fruh", "vormittags", "mittags", "nachmittags", "abends", "nachts"]);

/** "morgens", "in the morning", "Abends": a time of day without a clock time. */
function daypartOf(raw: string): { word: string; german: boolean } | null {
  const text = oneLine(raw);
  if (/\d/.test(text) || text.split(" ").length > 4) return null;
  const words = matchKey(text).split(/[^a-z]+/).filter(Boolean);
  const hit = words.find((x) => DAYPART_WORDS.has(x));
  if (!hit) return null;
  return { word: text.replace(/^(in the|am|an|ab)\s+/i, ""), german: GERMAN_DAYPARTS.has(hit) };
}

/**
 * A note is a short remark ("Ankunft morgens", "Tenderhafen"), never the whole row or a sentence: at most 5 words and
 * no clock time (the times have their own fields).
 */
function isRemark(note: string): boolean {
  return note.split(" ").length <= 5 && findTimes(matchKey(note)).length === 0;
}

/** A note is kept on the text path when most of its words are printed in the source (it is shown to the user). */
function noteInSource(note: string, src: SourceIndex): boolean {
  const words = foldText(note).split(" ").filter((w) => w.length >= 3);
  return words.length === 0 || words.filter((w) => src.words.has(w)).length * 2 >= words.length;
}

/**
 * Wire output -> raw stops (pure; never throws on model quirks).
 * - Invalid dates, times and `cc` become null; a time that is not HH:MM sets `time_unclear`.
 * - Stops without place and without `sea` are dropped; place cut to 80, note to 60.
 * - Text path (`source` given, documents and notes alike): every place must occur within one line of the source, else
 *   the stop is dropped (`drops.notInSource`). Every time must occur in the source, and every date or day number on
 *   the stop's lines (or carried from a line above them), else it is dropped and the stop gets `not_in_source`.
 *   Notes not printed in the source are dropped.
 * - Image path (`source` null): nothing can be checked; every stop gets `from_image`.
 * At most MAX_TRIP_STOPS.
 */
export function normalizeExtract(wire: WireItinerary, source: string | null): NormalizedExtract {
  const src = source === null ? null : indexSource(source);
  const drops: ExtractDrops = { notInSource: 0, noPlace: 0, invalid: 0 };
  const stops: RawStop[] = [];
  for (const w of wire.stops) {
    if (stops.length >= MAX_TRIP_STOPS) break;
    const flags = new Set<ItineraryFlag>();
    if (src === null) flags.add("from_image");

    const full = w.place ? oneLine(w.place) : "";
    const sea = w.sea === true;
    if (!sea && !full) {
      drops.noPlace += 1;
      continue;
    }
    // The source lines of this stop: where its place is printed (a sea day: lines with a sea-day word).
    const lines = src === null ? [] : sea ? src.lines.filter((l) => l.sea) : placeLines(full, src);
    if (!sea && src && lines.length === 0) {
      drops.notInSource += 1;
      continue;
    }
    // "La Valletta, Malta": the country becomes the hint (the model's own `cc` wins), not part of the name.
    const split = splitCountrySuffix(full);
    const place = cutAtWord(split.place, MAX_PLACE);

    let date = cleanDate(w.date);
    let day = w.day !== null && Number.isInteger(w.day) && w.day >= 1 && w.day <= 366 ? w.day : undefined;
    if (date === null) drops.invalid += 1; // unreadable date: the stop keeps its day number or the day before
    if (w.day !== null && day === undefined) drops.invalid += 1;
    // Text path: a date or day number not printed on the stop's lines (or carried from a line above them) would move
    // the stop to another day: dropped like a time, the stop flagged.
    if (src && date) {
      const checked = sourceDate(date, lines);
      if (checked === null) flags.add("not_in_source");
      date = checked ?? undefined;
    }
    const srcDay = day;
    if (src && srcDay !== undefined && !lines.some((l) => l.days.includes(srcDay))) {
      day = undefined;
      flags.add("not_in_source");
    }

    const times: { arr?: string; dep?: string } = {};
    let daypartNote = "";
    for (const k of sea ? [] : (["arr", "dep"] as const)) {
      const t = cleanTime(w[k]);
      const part = t === null ? daypartOf(w[k]!) : null;
      if (part && (!src || src.words.has(foldText(part.word)))) {
        // "morgens" in a time column: a remark, not an unreadable time ("Ankunft morgens").
        daypartNote ||= `${k === "arr" ? (part.german ? "Ankunft" : "Arrival") : part.german ? "Abfahrt" : "Departure"} ${part.word}`;
      } else if (t === null) flags.add("time_unclear");
      else if (t !== undefined) {
        if (src && !src.times.has(t)) flags.add("not_in_source");
        else times[k] = t;
      }
    }

    const cc = w.cc && /^[A-Za-z]{2}$/.test(w.cc.trim()) ? w.cc.trim().toUpperCase() : split.cc;
    let note = w.note ? oneLine(w.note).slice(0, MAX_NOTE).trim() : "";
    if (note && ((src && !noteInSource(note, src)) || !isRemark(note))) note = "";
    note ||= daypartNote;

    const stop: RawStop = {
      ...(date ? { date } : {}),
      ...(day !== undefined ? { day } : {}),
      ...(sea ? { sea: true as const } : { place }),
      ...(cc && !sea ? { cc } : {}),
      ...times,
      ...(note ? { note } : {}),
    };
    if (flags.size > 0) stop.flags = [...flags].sort();
    stops.push(stop);
  }
  return { stops, drops };
}
