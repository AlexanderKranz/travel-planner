import { EntryTraits, type GroupEntry, type StoredEntry } from "@/lib/domain/group";
import { GroupParse } from "@/lib/domain/group-text";
import { groupTextHash } from "@/lib/plan/hash";

/** A cached Haiku parse, only if it belongs to exactly this text (hash match) and is valid; else undefined. */
export function cachedParse(text: string | null, raw: unknown, hash: string | null): GroupParse | undefined {
  if (!text || !raw || hash !== groupTextHash(text)) return undefined;
  const parsed = GroupParse.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** snake_case row of public.group_entries. */
export type GroupEntryRow = {
  id: string;
  group_id: string;
  kind: "composition" | "member";
  position: number;
  count: number;
  label: string | null;
  name: string | null;
  is_self: boolean;
  birthdate: string | null;
  age_mode: "exact" | "approx" | "relativeToMe" | null;
  age: number | null;
  age_as_of: string | null;
  notes: string | null;
  traits: unknown;
};

export type GroupEntryWrite = Omit<GroupEntryRow, "id" | "group_id"> & { id?: string };

/**
 * Maps a validated entry to a DB row. `age_as_of` is set by the server: today,
 * unless the stated age is unchanged compared to `existing`, in which case the
 * old date is kept (so the age keeps advancing from the original statement).
 */
export function entryToRow(
  entry: GroupEntry,
  position: number,
  today: string,
  existing?: Pick<GroupEntryRow, "age_mode" | "age" | "age_as_of">,
): GroupEntryWrite {
  const stated = entry.age;
  const hasNumericAge = stated && stated.ageMode !== "relativeToMe";
  const age = hasNumericAge ? stated.age : null;
  const unchanged =
    existing && stated && existing.age_mode === stated.ageMode && existing.age === age && existing.age_as_of;
  return {
    ...(entry.id ? { id: entry.id } : {}),
    kind: entry.kind,
    position,
    count: entry.kind === "composition" ? entry.count : 1,
    label: entry.label ?? null,
    name: entry.kind === "member" ? (entry.name ?? null) : null,
    is_self: entry.kind === "member" ? entry.isSelf : false,
    birthdate: entry.kind === "member" ? (entry.birthdate ?? null) : null,
    age_mode: stated?.ageMode ?? null,
    age,
    age_as_of: hasNumericAge ? (unchanged ? existing.age_as_of : today) : null,
    notes: entry.notes ?? null,
    traits: entry.traits ?? {},
  };
}

/** DB row -> domain entry (null -> undefined, camelCase). */
export function rowToEntry(row: GroupEntryRow): StoredEntry {
  const traitsParsed = EntryTraits.safeParse(row.traits);
  const traits = traitsParsed.success ? traitsParsed.data : {};
  const age =
    row.age_mode === "relativeToMe"
      ? ({ ageMode: "relativeToMe" } as const)
      : row.age_mode && row.age !== null
        ? ({ ageMode: row.age_mode, age: row.age } as const)
        : undefined;
  const base = {
    id: row.id,
    position: row.position,
    label: row.label ?? undefined,
    notes: row.notes ?? undefined,
    traits,
    age,
    ageAsOf: row.age_as_of ?? undefined,
  };
  if (row.kind === "composition") {
    return { ...base, kind: "composition", count: row.count };
  }
  return {
    ...base,
    kind: "member",
    isSelf: row.is_self,
    name: row.name ?? undefined,
    birthdate: row.birthdate ?? undefined,
  };
}
