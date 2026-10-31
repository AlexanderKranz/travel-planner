import { REASON_MAX_CHARS } from "@/lib/domain/destination-search";

/**
 * A reason must not state flights, routes, times, distances, prices or opening hours (ground rule 1, spec section 4
 * [D5]). Zod cannot see this, so code does. The pattern may be strict: a false positive costs one sentence.
 * The u flag and lookarounds are needed because \b fails next to ö and ü. Substrings catch "Direktflug" and
 * "Flugzeit"; "Ausflug" and "Ausflüge" must survive.
 */
export const REASON_BANNED =
  /\d[\d.,]*\s?(km|kilometer|meilen|miles|mi|h|std|stunden?|hours?|min|minuten?|minutes?|euro|eur|usd)(?!\p{L})|[€$£]|(?<!aus)fl[uü]g|flieg|flight|(?<!\p{L})fly(?!\p{L})|airline|nonstop|direktverbindung|airport|geöffnet|öffnungszeit|opening hours|open daily/iu;

const MARKUP = /<[^>]*>|\(https?:[^)]*\)|[*_`#>[\]]+/g;

export type CleanedReason = { reason: string | null; removed: boolean };

/**
 * Trim, strip markup, cut at 160 characters. A reason that matches REASON_BANNED is removed (the verified card
 * stays, `removed: true` is counted in app_events). Empty input is `null` without counting as removed.
 */
export function cleanReason(raw: string): CleanedReason {
  const text = raw.replace(MARKUP, " ").replace(/\s+/g, " ").trim();
  if (!text) return { reason: null, removed: false };
  // Checked on the full text: a banned fact behind the cut must not be hidden by it.
  if (REASON_BANNED.test(text)) return { reason: null, removed: true };
  return { reason: text.length > REASON_MAX_CHARS ? text.slice(0, REASON_MAX_CHARS).trimEnd() : text, removed: false };
}
