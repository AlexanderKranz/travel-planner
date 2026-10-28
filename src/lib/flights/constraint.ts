import type { TripPurpose } from "@/lib/domain/purpose";

const AMOUNT = /(?:max(?:imal|\.)?|höchstens|bis zu|up to|at most|under|unter)\s*(\d{1,2}(?:[.,]\d)?)\s*(?:h|std\.?|stunden|hours?)(?![a-zäöüß])/gi;
const FLIGHT_WORD = /flug|flight|fly|flugzeit/i;
const NEAR = 25;

/** Hours in a free-text limit like "max 3 h flight" / "Flug höchstens 2,5 Stunden"; null when none (pure, no LLM). */
export function parseMaxFlightHours(text: string): number | null {
  for (const m of text.matchAll(AMOUNT)) {
    const start = m.index ?? 0;
    const around = text.slice(Math.max(0, start - NEAR), start + m[0].length + NEAR);
    if (!FLIGHT_WORD.test(around)) continue;
    const h = Number(m[1].replace(",", "."));
    if (h >= 1 && h <= 15) return h;
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
