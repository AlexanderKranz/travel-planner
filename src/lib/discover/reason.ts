import { REASON_MAX_CHARS } from "@/lib/domain/destination-search";

/**
 * A reason must not state flights, routes, times, distances, prices or opening hours (ground rule 1, spec section 4
 * [D5]). Zod cannot see this, so code does. The pattern may be strict: a false positive costs one sentence.
 * The u flag and lookarounds are needed because \b fails next to ö and ü. Substrings catch "Direktflug" and
 * "Flugzeit"; "Ausflug", "Ausflüge" and "Flüsse" must survive. The text is NFKC-normalised and stripped of format
 * characters first (`normalizeModelText`), so fullwidth digits, decomposed umlauts and zero-width spaces do not hide a fact.
 */
const PARTS = [
  // number + unit: distances, durations, prices ("2 h", "45 mins", "3-hour", "10 Autominuten", "99,- Euro", "80 Dollar")
  String.raw`\d[\d.,]*[\s-]{0,2}(?:km|kilometers?|kilometer|meilen|miles?|mi|h|hrs?|std|stunden?|hours?|mins?|minuten?|\p{L}+minuten|minutes?|euro|eur|usd|dollar|chf|gbp|franken|pfund)(?!\p{L})`,
  String.raw`[€$£¥]`,
  String.raw`(?<!\p{L})(?:chf|eur|usd|gbp)\s?\d`,
  // number words with a duration or distance ("zwei Stunden", "two hours", "half an hour")
  String.raw`(?<!\p{L})(?:ein|eine|einen|einer|zwei|drei|vier|f[uü]nf|sechs|sieben|acht|neun|zehn|elf|zw[oö]lf|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|halbe|halben|anderthalb|eineinhalb)\s+(?:an\s+)?(?:stunden?|hours?|hrs?|minuten?|minutes?|mins?|km|kilometer)(?!\p{L})`,
  // flights, airlines, airports
  String.raw`(?<!aus)fl[uü]g`,
  String.raw`flieg|flight|(?<!\p{L})fly(?!\p{L})|airline|airport|non[-\s]?stop|direktverbindung`,
  String.raw`(?<!\p{L})(?:ryanair|lufthansa|easyjet|eurowings|condor|tuifly|wizz|vueling|transavia|aegean)(?!\p{L})`,
  // opening hours
  String.raw`geöffnet|öffnungszeit|opening\s(?:hours|times)|open\s(?:daily|24)|\d\s?uhr|(?<!\d)24\s?/\s?7|rund um die uhr|(?<!\p{L})(?:mo|mon)\s?[-–]\s?(?:fr|fri|so|sun|sa|sat)(?!\p{L})|\d\s?(?:am|pm)(?!\p{L})`,
];
export const REASON_BANNED = new RegExp(PARTS.join("|"), "iu");

/** NFKC and no format characters (zero-width spaces, soft hyphens, bidi marks): the form the filters see. */
export const normalizeModelText = (s: string): string => s.normalize("NFKC").replace(/\p{Cf}/gu, "");

const MARKUP = /<[^>]*>|\(https?:[^)]*\)|[*_`#>[\]]+/g;

export type CleanedReason = { reason: string | null; removed: boolean };

/**
 * Trim, strip markup, cut at 160 characters. A reason that matches REASON_BANNED is removed (the verified card
 * stays, `removed: true` is counted in app_events). Empty input is `null` without counting as removed.
 */
export function cleanReason(raw: string): CleanedReason {
  const text = normalizeModelText(raw).replace(MARKUP, " ").replace(/\s+/g, " ").trim();
  if (!text) return { reason: null, removed: false };
  // Checked on the full text: a banned fact behind the cut must not be hidden by it.
  if (REASON_BANNED.test(text)) return { reason: null, removed: true };
  return { reason: text.length > REASON_MAX_CHARS ? text.slice(0, REASON_MAX_CHARS).trimEnd() : text, removed: false };
}
