import type { TripPurpose } from "@/lib/domain/purpose";
import { parseMaxFlightHours } from "@/lib/flights/constraint";
import { isInterestKey } from "@/lib/facts/interest-sources";
import { resolveGroup, type GroupSource } from "@/lib/group-text";
import { getAirport } from "@/lib/integrations/airports";
import { FALLBACK_SUMMARY_CHARS } from "@/lib/plan/input";

/** What the model sees in a destination search (spec find-destinations section 4). Canonical JSON, no timestamps. */
export type IdeaInput = {
  v: 1;
  lang: "de" | "en";
  purpose: {
    interests: string[];
    custom: string[];
    pace?: string;
    budget?: string;
    hard: string[];
    soft: string[];
    summary?: string;
  };
  months?: number[]; // 1..12, up to 3
  from?: string[]; // airport cities, e.g. ["Frankfurt am Main"]
  radiusKm?: number; // hint only
  group?: { adults: number; children: number; toddlers: number };
  count: 8;
  exclude?: string[]; // anchors of round 1, "Show others" only
};

/** A flight limit never reaches the model as a task: code applies it as a radius. */
const FLIGHT_WORD = /flug|flight|fly/i;
export const mentionsFlight = (s: string): boolean => parseMaxFlightHours(s) !== null || FLIGHT_WORD.test(s);

/** Sentences of a free text without the ones that mention a flight. */
export function withoutFlightSentences(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !mentionsFlight(s))
    .join(" ")
    .trim();
}

/** First day of the next occurrence of `month`: this year while the month is not over, else next year (rule 4). */
export function monthStartOnOrAfter(month: number, today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const year = month >= m ? y : y + 1;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/** Date for computing ages: the first day of the first chosen month, else today. */
export function ageDateFor(months: readonly number[], today: string): string {
  return months.length > 0 ? monthStartOnOrAfter(Math.min(...months), today) : today;
}

const clean = (xs: readonly string[]): string[] => {
  const out: string[] = [];
  for (const x of xs) {
    const t = x.replace(/\s+/g, " ").trim();
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
};

function purposePart(p: TripPurpose): IdeaInput["purpose"] {
  const g = p.guided ?? {};
  const t = p.tags;
  const interests: string[] = [];
  const custom: string[] = [];
  const addInterest = (s: string) => {
    if (s && !interests.includes(s)) interests.push(s);
  };
  const addCustom = (s: string) => {
    if (s && !custom.includes(s)) custom.push(s);
  };
  // Same rule as the plan input: typed custom interests are only used raw while there are no tags.
  for (const i of g.interests ?? []) {
    if (isInterestKey(i)) addInterest(i);
    else if (!t) addCustom(i);
  }
  for (const i of t?.interests ?? []) addInterest(i);
  for (const i of t?.custom ?? []) addCustom(i);
  // Tags replace the raw text; without tags the cut text and the constraints go in as-is (phase 3 D7).
  const hard = clean(t ? t.hard : p.constraints).filter((s) => !mentionsFlight(s));
  const soft = clean(t ? t.soft : []).filter((s) => !mentionsFlight(s));
  const rawSummary = t ? t.summary : (p.text ?? "").slice(0, FALLBACK_SUMMARY_CHARS);
  const summary = withoutFlightSentences(rawSummary.replace(/\s+/g, " ").trim());
  return {
    interests,
    custom,
    ...((g.pace ?? t?.pace) ? { pace: (g.pace ?? t?.pace)! } : {}),
    ...(g.budget ? { budget: g.budget } : {}),
    hard,
    soft,
    ...(summary ? { summary } : {}),
  };
}

export type IdeaInputSource = {
  lang: "de" | "en";
  purpose: TripPurpose;
  months: readonly number[];
  /** Origin IATA codes (airports that exist). */
  origins: readonly string[];
  /** Radius of the active flight limit; undefined = no limit. */
  radiusKm?: number;
  group: GroupSource | null;
  profileBirthdate: string | null;
  today: string;
  exclude?: readonly string[];
};

export function buildIdeaInput(s: IdeaInputSource): IdeaInput {
  const months = [...new Set(s.months)].sort((a, b) => a - b).slice(0, 3);
  const from = clean(s.origins.flatMap((o) => (getAirport(o)?.city ? [getAirport(o)!.city] : [])));
  // Counts only: no names, ages or notes. A text-only group has no counts and is left out.
  const summary = s.group ? resolveGroup(s.group, ageDateFor(months, s.today), s.profileBirthdate).summary : null;
  const group =
    summary && summary.adults + summary.children + summary.toddlers > 0
      ? { adults: summary.adults, children: summary.children, toddlers: summary.toddlers }
      : undefined;
  return {
    v: 1,
    lang: s.lang,
    purpose: purposePart(s.purpose),
    ...(months.length ? { months } : {}),
    ...(from.length ? { from } : {}),
    ...(s.radiusKm !== undefined && from.length ? { radiusKm: s.radiusKm } : {}),
    ...(group ? { group } : {}),
    count: 8,
    ...(s.exclude?.length ? { exclude: [...s.exclude] } : {}),
  };
}
