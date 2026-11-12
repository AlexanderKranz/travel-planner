import type { ItineraryContext, ItineraryFlag, ItineraryParseResult } from "@/lib/domain/itinerary";
import { splitCountrySuffix } from "./country";
import { mapStops, utcToday, type RawStop } from "./map";
import {
  ARR_WORDS,
  DAYPART_WORDS,
  DEP_WORDS,
  FILLER_WORDS,
  findDate,
  findDayNumber,
  findTimes,
  findUnclearTimes,
  isGermanMarker,
  matchKey,
  SEA_WORDS,
  weekdaySpans,
  type DateHit,
} from "./text";

/** A place longer than this many words is prose, not a port name: the line counts as unread (AI path). */
const MAX_PLACE_WORDS = 4;
/** Lower-case words that occur inside place names ("Palma de Mallorca", "Frankfurt am Main", "Stratford-upon-Avon"). */
const PARTICLES = new Set(["de", "del", "della", "di", "da", "do", "dos", "du", "des", "la", "le", "les", "el", "am", "an", "der", "den", "im", "in", "ob", "bei", "sur", "sul", "en", "of", "upon", "on", "y", "e", "i", "a"]);

/** A place with several lower-case words that are not particles is a sentence ("legen wir am späten Nachmittag"). */
function looksLikeProse(place: string): boolean {
  return place.split(/\s+/).filter((w) => /^\p{Ll}/u.test(w) && !PARTICLES.has(w.replace(/[.,]$/, ""))).length > 1;
}
const MAX_PLACE = 80;
const MAX_NOTE = 60;

type Header = { arr: boolean; dep: boolean; depFirst: boolean; dayColumn: boolean; german: boolean };
type Marker = "arr" | "dep";
type Tok =
  | { kind: "word"; start: number; end: number; w: string }
  | { kind: "time"; start: number; end: number; hhmm: string }
  | { kind: "dash"; start: number; end: number }
  | { kind: "sep"; start: number; end: number };

/** One stop under construction within a line. */
type Build = {
  placeStart?: number;
  placeEnd?: number;
  placeOpen: boolean;
  words: number;
  marked: Partial<Record<Marker, string>>;
  /** Unmarked time slots in order; null = an empty cell ("–"). */
  slots: (string | null)[];
  /** `slot` = how many unmarked time cells came before it (its column in a table). */
  daypart?: { marker: Marker | null; german: boolean; start: number; end: number; slot: number };
  unclear: boolean;
};

const newBuild = (): Build => ({ placeOpen: false, words: 0, marked: {}, slots: [], unclear: false });
const hasSlot = (b: Build) => b.slots.length > 0 || b.marked.arr !== undefined || b.marked.dep !== undefined || b.daypart !== undefined;

/** Replaces `[start, end)` with spaces (positions stay valid). */
const blank = (s: string, start: number, end: number) => s.slice(0, start) + " ".repeat(end - start) + s.slice(end);

const TOKEN = /(\p{L}[\p{L}\p{N}'’.-]*)|([–—]+|-+)|([,;|/])/gu;

function tokenize(key: string, times: { start: number; end: number; hhmm: string }[]): Tok[] {
  const toks: Tok[] = times.map((t) => ({ kind: "time", ...t }));
  for (let m = TOKEN.exec(key); m; m = TOKEN.exec(key)) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[1]) toks.push({ kind: "word", start, end, w: m[1].replace(/\.+$/, "") });
    else if (m[2]) toks.push({ kind: "dash", start, end });
    else toks.push({ kind: "sep", start, end });
  }
  TOKEN.lastIndex = 0;
  return toks.sort((a, b) => a.start - b.start);
}

function headerOf(words: string[]): Header | null {
  const arrAt = words.findIndex((w) => ARR_WORDS.has(w));
  const depAt = words.findIndex((w) => DEP_WORDS.has(w));
  const dayColumn = words.some((w) => w === "tag" || w === "day");
  if (words.length > 8 || (arrAt < 0 && depAt < 0 && !dayColumn)) return null;
  const german = [arrAt, depAt].some((i) => i >= 0 && isGermanMarker(words[i]));
  return { arr: arrAt >= 0, dep: depAt >= 0, depFirst: depAt >= 0 && arrAt >= 0 && depAt < arrAt, dayColumn, german };
}

/** Builds the stops of one line from its tokens. */
function buildStops(toks: Tok[], line: string): Build[] {
  const builds: Build[] = [];
  let cur: Build | null = null;
  let marker: { m: Marker; german: boolean } | null = null;
  const start = () => {
    cur = newBuild();
    builds.push(cur);
    return cur;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === "word") {
      const w = t.w;
      if (ARR_WORDS.has(w) || DEP_WORDS.has(w)) {
        marker = { m: ARR_WORDS.has(w) ? "arr" : "dep", german: isGermanMarker(w) };
        if (cur) (cur as Build).placeOpen = false;
        continue;
      }
      if (DAYPART_WORDS.has(w)) {
        const b: Build = cur ?? start();
        b.daypart ??= { marker: marker?.m ?? null, german: marker?.german ?? true, start: t.start, end: t.end, slot: b.slots.length };
        b.placeOpen = false;
        marker = null;
        continue;
      }
      if (FILLER_WORDS.has(w) || /^\d/.test(w)) continue;
      let b: Build = cur ?? start();
      if (b.placeStart !== undefined && !b.placeOpen && hasSlot(b)) {
        // A second port on the line starts with a capital ("…, Melk 15:00"); a trailing verb ("… 8 Uhr bestellen") is
        // not a port and is skipped.
        if (!/^[\p{Lu}\d]/u.test(line.slice(t.start, t.end))) continue;
        b = start();
      }
      if (b.placeStart === undefined) b.placeStart = t.start;
      b.placeEnd = t.end;
      b.placeOpen = true;
      b.words += 1;
      continue;
    }
    if (t.kind === "time") {
      const b: Build = cur ?? start();
      b.placeOpen = false;
      if (marker) {
        b.marked[marker.m] ??= t.hhmm;
        marker = null;
      } else b.slots.push(t.hhmm);
      continue;
    }
    if (t.kind === "dash") {
      const prev = toks[i - 1];
      const next = toks.slice(i + 1).find((x) => x.kind !== "sep");
      if (prev?.kind === "time" && next?.kind === "time") continue; // range 07:00–12:00
      const b = cur as Build | null;
      // An empty cell ("Passau – 16:00", "Melk 15:00 –"): only after a place and before a time, a dash or the end.
      if (b && b.placeStart !== undefined && (!next || next.kind === "time" || next.kind === "dash")) {
        b.slots.push(null);
        b.placeOpen = false;
      }
      continue;
    }
    if (cur) (cur as Build).placeOpen = false; // separator
  }
  return builds;
}

function cleanPlace(s: string): string {
  return s
    .replace(/^[\s,;:|/–—.-]+/, "")
    .replace(/[\s,;:|/–—-]+$/, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_PLACE)
    .trim();
}

/** "Ankunft morgens": the marker word, else the table column the day-part stands in, else the word alone. */
function daypartNote(d: NonNullable<Build["daypart"]>, original: string, header: Header | null): string {
  let marker = d.marker;
  let german = d.german;
  if (marker === null && header && header.arr && header.dep && d.slot <= 1) {
    marker = (d.slot === 0) !== header.depFirst ? "arr" : "dep";
    german = header.german;
  }
  if (marker === null) return original;
  const label = marker === "arr" ? (german ? "Ankunft" : "Arrival") : german ? "Abfahrt" : "Departure";
  return `${label} ${original}`;
}

/** Times of one stop: marked first, then the unmarked slots by the column header (section 3.3). */
function resolveTimes(b: Build, header: Header | null): { arr?: string; dep?: string; unclear: boolean } {
  let arr = b.marked.arr;
  let dep = b.marked.dep;
  const free = [...b.slots];
  // Under an arrive + depart header a day-part word fills its column ("Passau morgens 16:00": morgens = arrive).
  const d = b.daypart;
  if (d && d.marker === null && header?.arr && header.dep && d.slot <= 1 && d.slot <= free.length) free.splice(d.slot, 0, null);
  const times = free.filter((s): s is string => s !== null);
  let unclear = b.unclear || times.length > 2;
  if (arr === undefined && dep === undefined) {
    if (free.length >= 2) {
      const [a, c] = header?.depFirst ? [free[1], free[0]] : [free[0], free[1]];
      arr = a ?? undefined;
      dep = c ?? undefined;
    } else if (times.length === 1) {
      if (header && header.dep && !header.arr) dep = times[0];
      else arr = times[0];
    }
  } else if (arr === undefined) arr = times[0];
  else if (dep === undefined) dep = times[0];
  if (arr !== undefined && dep !== undefined && arr === dep && times.length === 0) unclear = true;
  return { ...(arr ? { arr } : {}), ...(dep ? { dep } : {}), unclear };
}

type LineDate = { date?: string; day?: number };

const isoOf = (d: DateHit) =>
  d.year === null
    ? `--${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`
    : `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/**
 * Year of a yearless date from an earlier date of the same document that printed one ("19.12.2037" ... "20.12."):
 * the first date on or after the previous one, at most a year later.
 */
function yearFromDocument(md: string, prev: string | null): string | null {
  if (!prev) return null;
  const y = Number(prev.slice(0, 4));
  for (const x of [y, y + 1]) {
    const iso = `${x}${md.slice(1)}`;
    if (!Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) && iso >= prev) return iso;
  }
  return null;
}

/** Raw stops of a text plus the number of rows that look like stops but could not be read. Pure. */
export function readStops(text: string): { stops: RawStop[]; incomplete: number } {
  const stops: RawStop[] = [];
  let incomplete = 0;
  let header: Header | null = null;
  /** Date context of a date-only line ("Sa, 19.12.") for the lines below it; `fresh` until a stop used it. */
  let context: (LineDate & { fresh: boolean }) | null = null;
  let lastFullDate: string | null = null;
  let lastStopLine = -2;

  const lines = text.normalize("NFC").split(/\r\n|\r|\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let key = matchKey(line);
    if (!key.trim()) continue;

    const parens: string[] = [];
    for (const m of key.matchAll(/\(([^()\d]{1,60})\)/g)) {
      parens.push(line.slice(m.index + 1, m.index + m[0].length - 1).trim());
      key = blank(key, m.index, m.index + m[0].length);
    }

    const date = findDate(key);
    if (date) {
      for (const [s, e] of weekdaySpans(key, date.start, date.end)) key = blank(key, s, e);
      key = blank(key, date.start, date.end);
    }
    let dayNum = findDayNumber(key);
    if (!date && !dayNum && header?.dayColumn) {
      const m = /^\s*(\d{1,2})(?=[\s.|:)–—-])/.exec(key);
      if (m && Number(m[1]) >= 1) dayNum = { start: 0, end: m[0].length, day: Number(m[1]) };
    }
    if (dayNum) key = blank(key, dayNum.start, dayNum.end);

    const sea = SEA_WORDS.exec(key);
    if (sea) key = blank(key, sea.index, sea.index + sea[0].length);
    const unclear = findUnclearTimes(key);
    for (const u of unclear) key = blank(key, u.start, u.end);
    const times = findTimes(key);
    for (const t of times) key = blank(key, t.start, t.end);

    const toks = tokenize(key, times);
    const words = toks.filter((t): t is Extract<Tok, { kind: "word" }> => t.kind === "word").map((t) => t.w);

    let lineDate: LineDate | null = null;
    if (date) {
      let iso = isoOf(date);
      if (date.year === null) iso = yearFromDocument(iso, lastFullDate) ?? iso;
      if (!iso.startsWith("--")) lastFullDate = iso;
      lineDate = { date: iso, ...(dayNum ? { day: dayNum.day } : {}) };
    } else if (dayNum) lineDate = { day: dayNum.day };

    if (!lineDate && !sea && times.length === 0 && unclear.length === 0) {
      const h = headerOf(words);
      if (h) {
        header = h;
        continue;
      }
    }

    const builds = sea ? [] : buildStops(toks, line);
    const flagsOf = (b?: Build): ItineraryFlag[] => (unclear.length > 0 || b?.unclear ? ["time_unclear"] : []);
    const noteOf = (b?: Build) => {
      const parts = [b?.daypart ? daypartNote(b.daypart, line.slice(b.daypart.start, b.daypart.end), header) : "", ...parens].filter(Boolean);
      const note = parts.join(", ").slice(0, MAX_NOTE).trim();
      return note ? { note } : {};
    };

    const pushStop = (b: Build, d: LineDate) => {
      const printed = cleanPlace(line.slice(b.placeStart, b.placeEnd));
      if (!printed || b.words > MAX_PLACE_WORDS || looksLikeProse(printed)) {
        incomplete += 1;
        return;
      }
      // "Messina (Sizilien), Italien": the country is the stop's hint, not part of its name.
      const { place, cc } = splitCountrySuffix(printed);
      const t = resolveTimes(b, header);
      const flags = t.unclear || unclear.length > 0 ? (["time_unclear"] as ItineraryFlag[]) : [];
      stops.push({
        ...d,
        place,
        ...(cc ? { cc } : {}),
        ...(t.arr ? { arr: t.arr } : {}),
        ...(t.dep ? { dep: t.dep } : {}),
        ...noteOf(b),
        ...(flags.length ? { flags } : {}),
      });
    };

    // Rows without their own date or day: a sea day or a stop below a date-only line, or a second port in a table.
    const fresh = context?.fresh === true;
    // An undated row continues the stop above only when its times are unambiguous: marked (an/ab), two times, or the
    // column header says what they are ("Datum Hafen Abfahrt" / "Melk 18:00", "Datum Hafen an ab" / "Melk – 18:00").
    const strict = (b: Build) => {
      const n = b.slots.filter(Boolean).length;
      if ((b.marked.arr ?? b.marked.dep) !== undefined || n >= 2) return true;
      if (!header || n !== 1) return false;
      return header.arr !== header.dep || (header.arr && b.slots.length >= 2);
    };
    const at: LineDate | null = lineDate ?? (context ? { ...(context.date ? { date: context.date } : {}), ...(context.day ? { day: context.day } : {}) } : null);

    if (sea) {
      if (!at) continue;
      stops.push({ ...at, sea: true, ...noteOf(), ...(flagsOf().length ? { flags: flagsOf() } : {}) });
      if (!lineDate && context) context.fresh = false;
      lastStopLine = li;
      continue;
    }

    const placed = builds.filter((b) => b.placeStart !== undefined);
    const timedOnly = builds.filter((b) => b.placeStart === undefined && hasSlot(b));

    if (!lineDate) {
      if (!at) continue;
      const usable = placed.filter((b) => fresh || (lastStopLine === li - 1 && strict(b)));
      if (usable.length === 0) {
        // Times on the line below a stop that had none ("Passau" / "Abfahrt 16:00").
        const prev = stops[stops.length - 1];
        const b = timedOnly[0];
        if (b && placed.length === 0 && prev && !prev.sea && lastStopLine === li - 1 && !prev.arr && !prev.dep) {
          const t = resolveTimes(b, header);
          Object.assign(prev, t.arr ? { arr: t.arr } : {}, t.dep ? { dep: t.dep } : {}, b.daypart && !prev.note ? noteOf(b) : {});
          lastStopLine = li;
        }
        continue;
      }
      for (const b of usable) pushStop(b, at);
      if (context) context.fresh = false;
      lastStopLine = li;
      continue;
    }

    if (placed.length === 0) {
      if (timedOnly.length > 0) incomplete += 1; // "20.12. 14:00 23:59": a row without a place
      else context = { ...lineDate, fresh: true }; // date-only line
      continue;
    }
    for (const b of placed) pushStop(b, lineDate);
    context = { ...lineDate, fresh: false };
    lastStopLine = li;
    if (timedOnly.length > 0) incomplete += 1;

  }
  return { stops, incomplete };
}

/**
 * Line-based itinerary parser (docs/specs/itinerary-upload.md section 3.3) on prefiltered text. Pure; browser and
 * server (trip notes). Maps dates to trip days with `ctx` and sets the section 3.5 flags.
 * - Each line: a date (`19.12.2037`, `19.12.`, `Sa 19. Dez`, `Dec 19`, ISO) or a day number ("Tag 3", "Day 3"), then
 *   the place, then up to two times. Several ports on one line are split at commas or semicolons after their times.
 * - First time = arrive, second = depart; a single time follows `an`/`ab`/`arr`/`dep`, else the column header, else
 *   arrive. A dash marks an empty cell.
 * - Sea-day words give `sea: true`. A missing year comes from an earlier date of the text, else from the trip dates
 *   (`year_guessed`).
 * - `usable` = at least 2 stops and no row that looked like a stop could not be read (else the AI path runs).
 * `today` (ISO) only matters for a yearless date when the trip has no start date.
 */
export function parseItinerary(text: string, ctx: ItineraryContext, today: string = utcToday()): ItineraryParseResult {
  const { stops: raw, incomplete } = readStops(text);
  const stops = mapStops(raw, ctx, today);
  return { stops, usable: stops.length >= 2 && incomplete === 0 && stops.every((s) => s.stop.sea === true || !!s.stop.place) };
}
