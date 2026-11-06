/**
 * Distances in plan prose (issue #142). The prompt forbids them (rule 4: the app shows verified distances and drive
 * times itself), but the model still writes "etwa 15 km entfernt". Code removes the number and its unit instead of
 * dropping the sentence: the rest of the sentence ("Rudervereine liegen weiter entfernt") keeps its meaning.
 * Speeds ("50 km/h") and times ("15 min") are not distances.
 */

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const UNIT = String.raw`(?:km|m|kilometer[ns]?|kilometres?|kilometers|meter[ns]?|metres?|meters|miles?|meilen)`;
/**
 * Number (or range: "10-15", "2 bis 3", "2 und 3") + distance unit (de + en). A number glued to a word ("A3") or
 * inside another number ("1.5" from "5") never starts a match; "ca.15 km" does. Shared with the eval check.
 */
export const DISTANCE_TEXT = new RegExp(
  String.raw`(?<![\p{L}\p{N}]|\d[.,])${NUM}(?:\s*(?:-|–|bis|to|und|and)\s*${NUM})?[\s-]?${UNIT}(?![\p{L}\p{N}/²³])`,
  "iu",
);

const APPROX = String.raw`(?:(?:etwa|ca\.|ca|circa|rund|ungefähr|knapp|gut|nur|über|unter|bis zu|zwischen|von|about|around|approx\.|approximately|roughly|nearly|almost|only|over|under|up to|some|between|from)\s*)?~?`;
const NUMBER_UNIT = DISTANCE_TEXT.source;
/** "15 km entfernt" / "15 km away": the phrase reads naturally with "weiter" / "further" instead of the number. */
const AWAY = new RegExp(String.raw`(?<![\p{L}])${APPROX}${NUMBER_UNIT}(\s+)(entfernt|away)\b`, "giu");
/** "5-km-Runde" → "Runde"; any other distance with its approximation word. */
const PHRASE = new RegExp(String.raw`(?<![\p{L}])${APPROX}${NUMBER_UNIT}(?:-(?=\p{L}))?`, "giu");

/** Removes distances from one text; `hit` tells the caller to count it. Never touches place names (caller's choice). */
export function stripDistances(s: string): { text: string; hit: boolean } {
  if (!DISTANCE_TEXT.test(s)) return { text: s, hit: false };
  const text = s
    .replace(AWAY, (m: string, sp: string, w: string) => {
      const word = w.toLowerCase() === "away" ? "further" : "weiter";
      return `${/^\p{Lu}/u.test(m) ? word[0].toUpperCase() + word.slice(1) : word}${sp}${w}`;
    })
    .replace(PHRASE, "")
    .replace(/\(\s*[,;]?\s*\)/g, "") // "(15 km)" → "()" → ""
    .replace(/\s+([,.;:!?)])/g, "$1")
    .replace(/([(])\s+/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/^\s*[,;:]\s*/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text, hit: true };
}
