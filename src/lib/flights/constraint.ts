import type { TripPurpose } from "@/lib/domain/purpose";

const LIMIT = "max(?:imal|\\.)?|höchstens|bis zu|up to|at most|no more than|not more than|nicht länger als|nicht mehr als|under|unter";
const AMOUNT = new RegExp(
  `(?:(?<limit>${LIMIT})\\s*)?(?<n>\\d{1,2}(?:[.,]\\d)?)\\s*(?:h|std\\.?|stunden|hours?)(?![a-zäöüß])`,
  "gi",
);
const FLIGHT_WORD = /flug|flight|fly/gi;
/** Another travel mode between the duration and the flight word means the limit is not about the flight. */
const OTHER_MODE = /fahrt|drive|driving|auto\b|car\b|zug|train|bahn|bus\b|schiff|ship|fähre|ferry/i;
const NEAR = 25;
const CLAUSE_SPLIT = /[;:!?]|[,.](?=\s)|\s[-–—]\s/;

/** Hours in a free-text limit like "max 3 h flight" / "Flug höchstens 2,5 Stunden" / "3 Std Flug"; null when none (pure, no LLM). */
export function parseMaxFlightHours(text: string): number | null {
  for (const clause of text.split(CLAUSE_SPLIT)) {
    for (const m of clause.matchAll(AMOUNT)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const h = Number(m.groups!.n.replace(",", "."));
      if (h < 1 || h > 15) continue;
      const after = clause.slice(end, end + NEAR);
      const before = clause.slice(Math.max(0, start - NEAR), start);
      const fa = after.search(/flug|flight|fly/i);
      let ok = fa >= 0 && !OTHER_MODE.test(after.slice(0, fa));
      if (!ok && m.groups!.limit) {
        const fb = [...before.matchAll(FLIGHT_WORD)].pop();
        ok = !!fb && !OTHER_MODE.test(before.slice((fb.index ?? 0) + fb[0].length));
      }
      if (ok) return h;
    }
  }
  return null;
}

/** Max block time in minutes from the purpose (spec section 4): guided field wins, then constraints/text, else null. */
export function maxBlockMinutes(p: TripPurpose | null): number | null {
  if (!p) return null;
  const g = p.guided?.maxFlightHours;
  if (g) return Math.round(g * 60);
  for (const s of [...(p.constraints ?? []), p.text ?? ""]) {
    const h = parseMaxFlightHours(s);
    if (h !== null) return Math.round(h * 60);
  }
  return null;
}
