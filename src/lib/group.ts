import { ageOn } from "./age";
import type { EntryTraits, StatedAge, TraitKey } from "./domain/group";

/** The part of a group entry that matters for age resolution. */
export type AgeSource = {
  id?: string;
  kind: "composition" | "member";
  count?: number;
  label?: string;
  name?: string;
  isSelf?: boolean;
  birthdate?: string;
  age?: StatedAge;
  /** Date the stated age was entered (set by the server on save). */
  ageAsOf?: string;
};

export type ResolvedAge =
  | { status: "known"; age: number; approximate: boolean }
  /** relativeToMe without a profile birthdate: "about my age". */
  | { status: "aboutMyAge" }
  | { status: "unknown" };

export type ResolvedEntry = {
  id?: string;
  kind: "composition" | "member";
  count: number;
  label?: string;
  name?: string;
  isSelf: boolean;
  age: ResolvedAge;
  /** Only for rows read from a group text; says adult/child/infant when no age is known. */
  role?: "adult" | "child" | "infant";
};

const UNKNOWN: ResolvedAge = { status: "unknown" };

export function safeAgeOn(birthdate: string, travelDate: string): number | null {
  try {
    return ageOn(birthdate, travelDate);
  } catch (error) {
    if (error instanceof RangeError) return null; // born after the travel date
    throw error;
  }
}

/** Whole years from `asOf` to `travelDate`, never negative. */
function yearsSince(asOf: string, travelDate: string): number {
  return safeAgeOn(asOf, travelDate) ?? 0;
}

/**
 * Age of one entry on the travel date. Ages are computed, never stored:
 * - birthdate -> exact age
 * - isSelf / relativeToMe -> from the profile birthdate (relativeToMe stays approximate)
 * - exact/approx -> stated age advanced by the full years since it was stated
 */
export function resolveAge(
  entry: AgeSource,
  travelDate: string,
  profileBirthdate?: string | null,
): ResolvedAge {
  if (entry.birthdate) {
    const age = safeAgeOn(entry.birthdate, travelDate);
    return age === null ? UNKNOWN : { status: "known", age, approximate: false };
  }
  if (entry.isSelf) {
    if (!profileBirthdate) return UNKNOWN;
    const age = safeAgeOn(profileBirthdate, travelDate);
    return age === null ? UNKNOWN : { status: "known", age, approximate: false };
  }
  const stated = entry.age;
  if (!stated) return UNKNOWN;
  if (stated.ageMode === "relativeToMe") {
    if (!profileBirthdate) return { status: "aboutMyAge" };
    const age = safeAgeOn(profileBirthdate, travelDate);
    return age === null ? { status: "aboutMyAge" } : { status: "known", age, approximate: true };
  }
  const advance = entry.ageAsOf ? yearsSince(entry.ageAsOf, travelDate) : 0;
  return {
    status: "known",
    age: stated.age + advance,
    approximate: stated.ageMode === "approx",
  };
}

/** Resolve every entry of a group for a travel date (input order is kept). */
export function resolveGroupAges(
  entries: AgeSource[],
  travelDate: string,
  profileBirthdate?: string | null,
): ResolvedEntry[] {
  return entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    count: entry.kind === "member" ? 1 : (entry.count ?? 1),
    label: entry.label,
    name: entry.name,
    isSelf: entry.isSelf ?? false,
    age: resolveAge(entry, travelDate, profileBirthdate),
  }));
}

/** Keeps only the traits whose key the group has enabled (no hidden data after deselecting). */
export function stripTraits(traits: EntryTraits | undefined, traitKeys: readonly TraitKey[]): EntryTraits {
  const allowed = new Set<string>(traitKeys);
  return Object.fromEntries(
    Object.entries(traits ?? {}).filter(([key, value]) => allowed.has(key) && value !== undefined),
  ) as EntryTraits;
}
