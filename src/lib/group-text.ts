import { z } from "zod";
import { GROUP_TEXT_FALLBACK_CHARS, GroupParse, type Traveller } from "./domain/group-text";
import type { EntryTraits, TraitKey } from "./domain/group";
import type { GroupSummary } from "./domain/plan";
import type { Trip } from "./domain/trip";
import {
  resolveGroupAges,
  safeAgeOn,
  stripTraits,
  type AgeSource,
  type ResolvedAge,
  type ResolvedEntry,
} from "./group";
import { partySize } from "./items/costs";

/** Wire schema of the Haiku call: lenient (strings/numbers), validated and clamped by `normalizeParse`. */
export const WireGroupParse = z.object({
  v: z.number(),
  travellers: z.array(
    z.object({
      count: z.number(),
      // Every field is required (null = not applicable): optional fields made the constrained decoder emit broken
      // strings in recorded runs (docs/specs/group-text.md [D12]).
      ageMode: z.string().describe("exact|approx|relativeToMe").nullable(),
      age: z.number().nullable(),
      ageOffset: z.number().nullable(),
      label: z.string().nullable(),
      role: z.string().describe("adult|child|infant").nullable(),
    }),
  ),
  notes: z.array(z.string()),
});
export type WireGroupParse = z.infer<typeof WireGroupParse>;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Wire output -> validated parse. Unknown modes/roles are dropped, numbers clamped; never throws on model quirks. */
export function normalizeParse(wire: WireGroupParse): GroupParse {
  const travellers: Traveller[] = [];
  for (const w of wire.travellers) {
    if (!Number.isFinite(w.count)) continue;
    const t: Traveller = { count: clamp(w.count, 1, 50) };
    if (w.ageMode === "relativeToMe") {
      t.ageMode = "relativeToMe";
      t.ageOffset = w.ageOffset !== null && Number.isFinite(w.ageOffset) ? clamp(w.ageOffset, -60, 60) : 0;
    } else if ((w.ageMode === "exact" || w.ageMode === "approx") && w.age !== null && Number.isFinite(w.age) && w.age >= 0) {
      t.ageMode = w.ageMode;
      t.age = clamp(w.age, 0, 120);
    }
    if (w.role === "adult" || w.role === "child" || w.role === "infant") t.role = w.role;
    const label = w.label ? oneLine(w.label).slice(0, 60) : "";
    if (label) t.label = label;
    travellers.push(t);
  }
  const notes: string[] = [];
  for (const n of wire.notes) {
    const x = oneLine(n).slice(0, 200);
    if (x && !notes.some((o) => o.toLowerCase() === x.toLowerCase())) notes.push(x);
  }
  return GroupParse.parse({ v: 1, travellers: travellers.slice(0, 30), notes: notes.slice(0, 10) });
}

/**
 * Age of a parsed traveller on the travel date (ages are computed, never stored).
 * relativeToMe = profile age on that date + offset; without a profile birthdate only "about my age" (offset 0).
 */
export function resolveTravellerAge(t: Traveller, travelDate: string, profileBirthdate?: string | null): ResolvedAge {
  if (t.ageMode === "relativeToMe") {
    const offset = t.ageOffset ?? 0;
    const mine = profileBirthdate ? safeAgeOn(profileBirthdate, travelDate) : null;
    if (mine === null) return offset === 0 ? { status: "aboutMyAge" } : { status: "unknown" };
    return { status: "known", age: Math.max(0, mine + offset), approximate: true };
  }
  if ((t.ageMode === "exact" || t.ageMode === "approx") && t.age !== undefined) {
    return { status: "known", age: t.age, approximate: t.ageMode === "approx" };
  }
  return { status: "unknown" };
}

/** What a group is made of, whichever way it was described. */
export type GroupSource = {
  /** Saved entries (named members, or the structure the user corrected). Win over everything else. */
  entries: (AgeSource & { traits?: EntryTraits; notes?: string })[];
  traitKeys: readonly TraitKey[];
  notes?: string;
  /** Free text; may be the only information. */
  description?: string;
  /** Haiku parse of exactly this description (hash checked by the caller), else null. */
  parse?: GroupParse | null;
};

export type ResolvedRow = ResolvedEntry & { traits?: EntryTraits; notes?: string };
export type GroupStructureSource = "entries" | "parse" | "text";
export type ResolvedGroup = {
  /** entries = saved structure > parse = Haiku > text = raw text only. */
  source: GroupStructureSource;
  rows: ResolvedRow[];
  /** Notes for the plan: group notes + parse notes (or the cut raw text when there is no parse). */
  notes?: string;
  size: number;
  summary: GroupSummary;
};

export function summarizeRows(rows: ResolvedEntry[]): GroupSummary {
  const s: GroupSummary = { total: 0, adults: 0, children: 0, toddlers: 0, unknown: 0 };
  for (const r of rows) {
    s.total += r.count;
    if (r.age.status === "known") {
      const a = r.age.age;
      if (a <= 2) s.toddlers += r.count;
      else if (a <= 17) s.children += r.count;
      else s.adults += r.count;
    } else if (r.age.status === "aboutMyAge") s.adults += r.count;
    else if (r.role === "adult") s.adults += r.count;
    else if (r.role === "child") s.children += r.count;
    else if (r.role === "infant") s.toddlers += r.count;
    else s.unknown += r.count;
  }
  return s;
}

const joinNotes = (parts: (string | undefined)[]): string | undefined => parts.filter(Boolean).join("; ") || undefined;

/**
 * One resolution for plan input, party size and display. Order: saved entries (named members or the structure the
 * user corrected) > Haiku parse of the text > raw text only (cut, as notes).
 */
export function resolveGroup(src: GroupSource, travelDate: string, profileBirthdate?: string | null): ResolvedGroup {
  const text = src.description?.trim() || undefined;
  const parse = text && src.parse && src.parse.travellers.length > 0 ? src.parse : null;
  const textNotes = text ? (parse ? parse.notes.join("; ") || undefined : text.slice(0, GROUP_TEXT_FALLBACK_CHARS)) : undefined;

  if (src.entries.length > 0) {
    const ages = resolveGroupAges(src.entries, travelDate, profileBirthdate);
    const rows = ages.map((r, i) => {
      const stored = src.entries[i];
      const traits = stripTraits(stored.traits, src.traitKeys);
      return { ...r, traits: Object.keys(traits).length ? traits : undefined, notes: stored.notes || undefined };
    });
    const summary = summarizeRows(rows);
    return { source: "entries", rows, notes: joinNotes([src.notes || undefined, textNotes]), size: summary.total, summary };
  }
  if (parse) {
    const rows: ResolvedRow[] = parse.travellers.map((t) => ({
      kind: "composition",
      count: t.count,
      label: t.label,
      isSelf: false,
      age: resolveTravellerAge(t, travelDate, profileBirthdate),
      role: t.role,
    }));
    const summary = summarizeRows(rows);
    return { source: "parse", rows, notes: joinNotes([src.notes || undefined, textNotes]), size: summary.total, summary };
  }
  return {
    source: "text",
    rows: [],
    notes: joinNotes([src.notes || undefined, textNotes]),
    size: 0,
    summary: { total: 0, adults: 0, children: 0, toddlers: 0, unknown: 0 },
  };
}

/** Party size for costs, from the same resolution as the plan input; null when no people are known. */
export function groupPartySize(r: ResolvedGroup | null): number | null {
  return r ? partySize(r.rows.map((x) => x.count)) : null;
}

/** The one-off group of a trip (free text, optional corrected structure, parse) as a resolvable source. */
export function tripGroupSource(trip: Pick<Trip, "groupText" | "groupStructure" | "groupParse">): GroupSource | null {
  const structure = trip.groupStructure ?? [];
  if (!trip.groupText && structure.length === 0) return null;
  return {
    entries: structure.map((e) => ({
      kind: "composition" as const,
      count: e.count,
      label: e.label,
      notes: e.notes,
      age: e.age,
      ageAsOf: e.ageAsOf,
    })),
    traitKeys: [],
    description: trip.groupText,
    parse: trip.groupParse ?? null,
  };
}

export type AgeFacts =
  | { kind: "none" }
  | { kind: "aboutMe" }
  | { kind: "known"; min: number; max: number; approx: boolean };

/** Numbers behind the one-line summary ("5 adults, about 46"); the UI turns them into text. */
export function summaryFacts(r: ResolvedGroup): { counts: GroupSummary; age: AgeFacts } {
  const known = r.rows.flatMap((x) => (x.age.status === "known" ? [{ age: x.age.age, approx: x.age.approximate }] : []));
  let age: AgeFacts = { kind: "none" };
  if (known.length > 0) {
    age = {
      kind: "known",
      min: Math.min(...known.map((k) => k.age)),
      max: Math.max(...known.map((k) => k.age)),
      approx: known.some((k) => k.approx),
    };
  } else if (r.rows.some((x) => x.age.status === "aboutMyAge")) {
    age = { kind: "aboutMe" };
  }
  return { counts: r.summary, age };
}
