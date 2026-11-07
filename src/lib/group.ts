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
  /** This entry stands for the trip owner (plan label "self"): the is_self row when T = G, the linked entry when T != G. */
  isTripOwner: boolean;
  /** Display only (typed birthdate, or the group owner's for the is_self row); the plan input never copies it. */
  birthdate?: string;
  age: ResolvedAge;
  /** Only for rows read from a group text; says adult/child/infant when no age is known. */
  role?: "adult" | "child" | "infant";
};

/**
 * Who `is_self` and `relativeToMe` refer to (spec group-sharing 1.4). Depends on the TRIP OWNER (T), never on the viewer
 * or the actor, so a plan and its hash look the same to everyone who sees that trip.
 */
export type AgeRefs = {
  /** Group owner's profile birthdate (what `is_self` resolves to). */
  self: string | null;
  /** What "about my age" resolves to: a birthdate, or the age of the entry the trip owner linked (fallback: their profile). */
  me: { birthdate: string | null } | { entryId: string; fallback: string | null };
  /** Wording only: "about my age" vs "about {name}'s age". */
  meIs: "tripOwner" | "groupOwner";
  /** Entry that stands for the trip owner (plan label "self"): the is_self id when T = G, the linked entry when T != G. */
  tripOwnerEntryId: string | null;
};

export function ageRefs(a: {
  tripOwnerId: string;
  tripOwnerBirthdate: string | null;
  /** null: own group or the trip's one-off group (T = G). */
  groupOwnerId: string | null;
  groupOwnerBirthdate: string | null;
  entries: { id?: string; isSelf?: boolean; linkedUserId?: string | null }[];
}): AgeRefs {
  if (!a.groupOwnerId || a.groupOwnerId === a.tripOwnerId) {
    const selfEntry = a.entries.find((e) => e.isSelf);
    return {
      self: a.tripOwnerBirthdate,
      me: { birthdate: a.tripOwnerBirthdate },
      meIs: "tripOwner",
      tripOwnerEntryId: selfEntry?.id ?? null,
    };
  }
  const linked = a.entries.find((e) => !e.isSelf && e.id && e.linkedUserId === a.tripOwnerId);
  if (linked?.id) {
    return {
      self: a.groupOwnerBirthdate,
      me: { entryId: linked.id, fallback: a.tripOwnerBirthdate },
      meIs: "tripOwner",
      tripOwnerEntryId: linked.id,
    };
  }
  return {
    self: a.groupOwnerBirthdate,
    me: { birthdate: a.groupOwnerBirthdate },
    meIs: "groupOwner",
    tripOwnerEntryId: null,
  };
}

/** T = G with one birthdate for `is_self` and `relativeToMe`: today's behaviour. */
export function ownAgeRefs(birthdate: string | null): AgeRefs {
  return { self: birthdate, me: { birthdate }, meIs: "tripOwner", tripOwnerEntryId: null };
}

/** A plain string (or null) keeps today's meaning: one birthdate for both. */
export function toAgeRefs(refs: AgeRefs | string | null | undefined): AgeRefs {
  if (refs && typeof refs === "object") return refs;
  return ownAgeRefs(refs ?? null);
}

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
 * The age "about my age" refers to on the travel date, or null when nothing is known. For a linked entry: its
 * birthdate, else its stated age (advanced by `ageAsOf`), else the fallback birthdate (spec 1.4). A relativeToMe entry
 * that is itself the linked one has no age data of its own and takes the fallback.
 */
export function meAge(refs: AgeRefs, travelDate: string, entries: readonly AgeSource[] = []): number | null {
  if ("birthdate" in refs.me) return refs.me.birthdate ? safeAgeOn(refs.me.birthdate, travelDate) : null;
  const { entryId, fallback } = refs.me;
  const entry = entries.find((e) => e.id === entryId);
  if (entry?.birthdate) return safeAgeOn(entry.birthdate, travelDate);
  const stated = entry?.age;
  if (entry && stated && stated.ageMode !== "relativeToMe") {
    return stated.age + (entry.ageAsOf ? yearsSince(entry.ageAsOf, travelDate) : 0);
  }
  return fallback ? safeAgeOn(fallback, travelDate) : null;
}

/**
 * Age of one entry on the travel date. Ages are computed, never stored:
 * - birthdate -> exact age
 * - isSelf -> from the group owner's profile birthdate (`refs.self`)
 * - relativeToMe -> `meAge` (stays approximate)
 * - exact/approx -> stated age advanced by the full years since it was stated
 * `entries` is only needed when `refs.me` points at an entry. A plain string keeps today's meaning (one birthdate).
 */
export function resolveAge(
  entry: AgeSource,
  travelDate: string,
  refs?: AgeRefs | string | null,
  entries: readonly AgeSource[] = [],
): ResolvedAge {
  const r = toAgeRefs(refs);
  if (entry.birthdate) {
    const age = safeAgeOn(entry.birthdate, travelDate);
    return age === null ? UNKNOWN : { status: "known", age, approximate: false };
  }
  if (entry.isSelf) {
    if (!r.self) return UNKNOWN;
    const age = safeAgeOn(r.self, travelDate);
    return age === null ? UNKNOWN : { status: "known", age, approximate: false };
  }
  const stated = entry.age;
  if (!stated) return UNKNOWN;
  if (stated.ageMode === "relativeToMe") {
    const age = meAge(r, travelDate, entries);
    return age === null ? { status: "aboutMyAge" } : { status: "known", age, approximate: true };
  }
  const advance = entry.ageAsOf ? yearsSince(entry.ageAsOf, travelDate) : 0;
  return {
    status: "known",
    age: stated.age + advance,
    approximate: stated.ageMode === "approx",
  };
}

/** Does this entry stand for the trip owner (plan label "self")? */
function standsForTripOwner(entry: AgeSource, refs: AgeRefs): boolean {
  // T = G: `me` is a birthdate and the is_self row is the trip owner. T != G: only the linked entry.
  if ("birthdate" in refs.me) return refs.meIs === "tripOwner" && (entry.isSelf ?? false);
  return entry.id !== undefined && entry.id === refs.me.entryId;
}

/** Resolve every entry of a group for a travel date (input order is kept). */
export function resolveGroupAges(
  entries: AgeSource[],
  travelDate: string,
  refs?: AgeRefs | string | null,
): ResolvedEntry[] {
  const r = toAgeRefs(refs);
  return entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    count: entry.kind === "member" ? 1 : (entry.count ?? 1),
    label: entry.label,
    name: entry.name,
    isSelf: entry.isSelf ?? false,
    isTripOwner: standsForTripOwner(entry, r),
    birthdate: entry.birthdate ?? (entry.isSelf ? (r.self ?? undefined) : undefined),
    age: resolveAge(entry, travelDate, r, entries),
  }));
}

/** Keeps only the traits whose key the group has enabled (no hidden data after deselecting). */
export function stripTraits(traits: EntryTraits | undefined, traitKeys: readonly TraitKey[]): EntryTraits {
  const allowed = new Set<string>(traitKeys);
  return Object.fromEntries(
    Object.entries(traits ?? {}).filter(([key, value]) => allowed.has(key) && value !== undefined),
  ) as EntryTraits;
}
