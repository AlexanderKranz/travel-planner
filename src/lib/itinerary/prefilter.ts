import { MAX_ITINERARY_TEXT } from "@/lib/domain/itinerary";
import { findDate, findDayNumber, findTimes, matchKey, SEA_WORDS, WEEKDAY_FULL } from "./text";

/** A neighbour line longer than this is prose, not a column header or a place line. */
const MAX_NEIGHBOUR = 80;

/**
 * Labels and values that never belong to an itinerary row: personal data, booking data, prices and contact details.
 * Such a line is never kept as a neighbour (it is kept only when it is itself a row with a date or time).
 */
const PRIVATE_LINE =
  /@|\b(passagier\w*|passenger\w*|gast|gaste|guest\w*|name|vorname|nachname|reisende\w*|traveller\w*|buchung\w*|booking|reservierung\w*|reservation|kabine|cabin|preis\w*|price|total|summe|gesamt\w*|betrag|iban|bic|kunde\w*|customer|telefon|phone|tel|e-?mail|adresse|address|geburt\w*|birth\w*|pass|passport)\b|€|\beur\b|\$|\d{5,}|\b[a-z]{1,4}-?\d{4,}\b/;

/** Column header of an itinerary table ("Datum | Hafen | Ankunft | Abfahrt", "Day Port Arr Dep"). */
const HEADER_WORDS =
  /\b(datum|date|tag|day|hafen|port|ort|place|stadt|city|ankunft|abfahrt|arrival|departure|an|ab|arr|dep|anlegen|ablegen)\b/g;

/** At least two header words in a short line: a column header, not a sentence that happens to contain "ab". */
function isHeader(key: string): boolean {
  if (key.split(/\s+/).length > 8) return false;
  return new Set(key.match(HEADER_WORDS) ?? []).size >= 2;
}

/** A row that has a date or day but no time: the next line may hold its place ("Samstag, 19.12." / "Passau"). */
function isDateOnly(line: string): boolean {
  let key = matchKey(line);
  const date = findDate(key);
  // "19.12." must not count as the time 19:12.
  if (date) key = key.slice(0, date.start) + " ".repeat(date.end - date.start) + key.slice(date.end);
  return (date !== null || WEEKDAY_FULL.test(key) || findDayNumber(key) !== null) && findTimes(key).length === 0;
}

/** A row of a day-column table: a bare day number, then a word ("2 | Wien | – | –", "3. Melk"). */
const DAY_ROW = /^(\d{1,2})\s*[.|:)–—-]?\s*\p{L}/u;
const DAY_HEADER = /\b(tag|day)\b/;

/**
 * Rows of a day-column table ("Tag | Hafen | an | ab" / "2 | Wien | – | –") count as itinerary rows even without a
 * time, and so does their header. The table ends at the first other non-empty line that is no itinerary row.
 */
function markDayTables(lines: string[], hit: boolean[]): void {
  for (let i = 0; i < lines.length; i++) {
    const key = matchKey(lines[i]);
    if (hit[i] || !isHeader(key) || !DAY_HEADER.test(key) || PRIVATE_LINE.test(key)) continue;
    let rows = 0;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (!lines[j]) continue;
      if (hit[j]) continue;
      const m = DAY_ROW.exec(lines[j]);
      if (!m || Number(m[1]) < 1 || lines[j].length > MAX_NEIGHBOUR || PRIVATE_LINE.test(matchKey(lines[j]))) break;
      hit[j] = true;
      rows += 1;
    }
    if (rows > 0) hit[i] = true;
    i = j - 1;
  }
}

/** Line looks like an itinerary row: date, weekday name, day number, time or sea-day word (section 3.2). */
export function isItineraryLine(line: string): boolean {
  const key = matchKey(line.normalize("NFC"));
  return findDate(key) !== null || WEEKDAY_FULL.test(key) || findDayNumber(key) !== null || findTimes(key).length > 0 || SEA_WORDS.test(key);
}

/**
 * Keeps only itinerary-like lines (dates, weekdays, day numbers, times, sea-day words) plus one neighbour line each,
 * capped at MAX_ITINERARY_TEXT (docs/specs/itinerary-upload.md section 3.2). Pure; browser and server.
 * A neighbour is kept only when it is short, carries no personal, booking or price data, and is a column header
 * ("Datum Hafen Ankunft Abfahrt") or the place line between a date-only row and its times. Names and booking numbers
 * above or below the table do not survive.
 */
export function prefilterItinerary(text: string): string {
  const lines = text
    .normalize("NFC")
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\s+/g, " ").trim());
  const hit = lines.map(isItineraryLine);
  markDayTables(lines, hit);
  const keep = lines.map((l, i) => {
    if (!l) return false;
    if (hit[i]) return true;
    if (!(hit[i - 1] || hit[i + 1]) || l.length > MAX_NEIGHBOUR) return false;
    const key = matchKey(l);
    if (PRIVATE_LINE.test(key)) return false;
    // A lone neighbour may be a name ("Erika Mustermann" above or inside the table): kept only as a column header, or
    // as the place below a date-only row (followed by its times, or the last line of the text).
    return isHeader(key) || (isDateOnly(lines[i - 1] ?? "") && (hit[i + 1] || lines.slice(i + 1).every((x) => !x)));
  });
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue;
    const next = out ? `${out}\n${lines[i]}` : lines[i];
    if (next.length > MAX_ITINERARY_TEXT) break;
    out = next;
  }
  return out;
}
