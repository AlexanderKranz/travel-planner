/**
 * Invented arrival/departure times at scheduled stops (issue #142, prompt rule 5, concrete-places D9). The trip notes
 * hold the travellers' own schedule ("Passau an morgens"); the model sometimes turns "morning" into "09:00 Ankunft".
 * Code drops `at`/`until` of an arrival or departure activity at a stop the notes name when that time is not in the
 * notes. Other activities keep their times: those are the plan's own suggestions, not schedule facts.
 */
import type { PlanActivity } from "@/lib/domain/plan";

/** Arrival/departure of the scheduled transport (de + en). "Anreise"/"Abreise" (the travellers' own trip) are not. */
export const ARRIVAL_DEPARTURE =
  /ankunft|ankommen|anleg|ausschiff|einschiff|ablegen|abfahrt|arrival|arrive|arriving|docking|\bdocks?\b|disembark|embark|departure|depart|sets? sail|sailing/i;

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Name part of a stop place ("Passau: Ausschiffung", "Melk (Stift)" → "Passau", "Melk"). */
const placeName = (place: string) => place.split(/[(:,–—/]| - /)[0].trim();

/** True when the user's notes name this stop's place as a whole word (case and accents ignored). */
export function notesNamePlace(notes: string | undefined, place: string): boolean {
  const name = fold(placeName(place));
  if (!notes || name.length < 3) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, "u").test(fold(notes));
}

/**
 * Drops invented times of arrival/departure activities at a stop the notes name. Returns the activities (new objects
 * only where changed) and how many lost a time.
 */
export function guardScheduleTimes(
  acts: PlanActivity[],
  place: string,
  notes: string | undefined,
  noteTimes: Set<string>,
): { acts: PlanActivity[]; dropped: number } {
  if (!notesNamePlace(notes, place)) return { acts, dropped: 0 };
  let dropped = 0;
  const out = acts.map((a) => {
    if (a.kind !== "travel" || !ARRIVAL_DEPARTURE.test(a.text)) return a;
    const badAt = !!a.at && !noteTimes.has(a.at);
    const badUntil = !!a.until && !noteTimes.has(a.until);
    if (!badAt && !badUntil) return a;
    dropped += 1;
    const copy = { ...a };
    // An invented start makes its end meaningless too; an end alone that is invented goes on its own.
    if (badAt) {
      delete copy.at;
      delete copy.until;
    } else delete copy.until;
    return copy;
  });
  return { acts: out, dropped };
}
