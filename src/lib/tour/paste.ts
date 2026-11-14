/**
 * "Liste einfügen" (spec 17.1, small items): split pasted text into place names. Pure, no LLM (rule 2).
 *
 * With line breaks, every line is one name (commas stay: "Café Central, Wien"); a line may also hold several names
 * separated by ";". Without line breaks, ";" or "," separate names. Bullets and numbering ("1.", "2)", "-", "•", "*")
 * are removed; names shorter than the search minimum are dropped; duplicates (case-insensitive) are kept once.
 */
import { PLACE_SEARCH_MIN_CHARS } from "./search-client";

const BULLET = /^\s*(?:[-–•*·]+|\d{1,2}\s*[.)]|\(\d{1,2}\))\s*/;

export function splitPlaceList(text: string, max: number): string[] {
  const multiline = /\r?\n/.test(text.trim());
  const parts = multiline ? text.split(/\r?\n/).flatMap((l) => l.split(";")) : text.split(/[;,]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const name = raw.replace(BULLET, "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (name.length < PLACE_SEARCH_MIN_CHARS) continue;
    const k = name.toLocaleLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}
