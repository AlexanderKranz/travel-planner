import { z } from "zod";
import { ITINERARY_FLAGS, type ItineraryFlag } from "@/lib/domain/itinerary";
import { MAX_TRIP_STOPS } from "@/lib/domain/trip-stops";
import { isValidIso, isValidYearless, type RawStop } from "./map";
import { findTimes, foldText, matchKey } from "./text";

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

/** The source as a folded word string and its set of times, for the not_in_source check (text path only). */
export type SourceIndex = { folded: string; words: Set<string>; times: Set<string> };

export function indexSource(text: string): SourceIndex {
  const folded = ` ${foldText(text)} `;
  const times = new Set<string>();
  for (const line of text.normalize("NFC").split(/\r\n|\r|\n/)) for (const t of findTimes(matchKey(line))) times.add(t.hhmm);
  return { folded, words: new Set(folded.trim().split(" ")), times };
}

/** The place occurs in the source: as a folded phrase, or every word of it does ("Wien, Österreich" vs "Wien (Österreich)"). */
export function placeInSource(place: string, src: SourceIndex): boolean {
  const f = foldText(place);
  if (!f) return false;
  return src.folded.includes(` ${f} `) || f.split(" ").every((w) => src.words.has(w));
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
 * - Text path (`source` given, documents and notes alike): every place must occur in the source text, else the stop
 *   is dropped (`drops.notInSource`); every time must occur in the source, else it is dropped and the stop gets
 *   `not_in_source`. Notes not printed in the source are dropped.
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
    if (!sea && src && !placeInSource(full, src)) {
      drops.notInSource += 1;
      continue;
    }
    const place = cutAtWord(full, MAX_PLACE);

    const date = cleanDate(w.date);
    const day = w.day !== null && Number.isInteger(w.day) && w.day >= 1 && w.day <= 366 ? w.day : undefined;
    if (date === null) drops.invalid += 1; // unreadable date: the stop keeps its day number or the day before
    if (w.day !== null && day === undefined) drops.invalid += 1;

    const times: { arr?: string; dep?: string } = {};
    for (const k of sea ? [] : (["arr", "dep"] as const)) {
      const t = cleanTime(w[k]);
      if (t === null) flags.add("time_unclear");
      else if (t !== undefined) {
        if (src && !src.times.has(t)) flags.add("not_in_source");
        else times[k] = t;
      }
    }

    const cc = w.cc && /^[A-Za-z]{2}$/.test(w.cc.trim()) ? w.cc.trim().toUpperCase() : undefined;
    let note = w.note ? oneLine(w.note).slice(0, MAX_NOTE).trim() : "";
    if (note && src && !noteInSource(note, src)) note = "";

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
