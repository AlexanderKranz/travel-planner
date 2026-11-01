"use server";

import { z } from "zod";
import {
  TRAIT_KEYS,
  TravelGroupInput,
  type GroupEntry,
  type TraitKey,
  type TravelGroup,
  type TravelGroupSummary,
} from "@/lib/domain/group";
import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
import { stripTraits } from "@/lib/group";
import { logEvent } from "./events";
import { ensureGroupParse } from "./group-text";
import { cachedParse, entryToRow, rowToEntry, type GroupEntryRow } from "./group-mapping";
import { getUserSession, todayIso } from "./session";

const Id = z.string().uuid();
const GROUP_COLUMNS = "id, name, notes, description, parsed_structure, parsed_hash, trait_keys, created_at, updated_at";
const ENTRY_COLUMNS =
  "id, group_id, kind, position, count, label, name, is_self, birthdate, age_mode, age, age_as_of, notes, traits";

type GroupRow = {
  id: string;
  name: string;
  notes: string | null;
  description: string | null;
  parsed_structure: unknown;
  parsed_hash: string | null;
  trait_keys: string[];
  created_at: string;
  updated_at: string;
};

function withStrippedTraits<E extends GroupEntry>(entry: E, traitKeys: TraitKey[]): E {
  return { ...entry, traits: stripTraits(entry.traits, traitKeys) };
}

function toGroup(row: GroupRow, entries: GroupEntryRow[]): TravelGroup {
  return {
    id: row.id,
    name: row.name,
    notes: row.notes ?? undefined,
    description: row.description ?? undefined,
    parse: cachedParse(row.description, row.parsed_structure, row.parsed_hash),
    traitKeys: row.trait_keys.filter((k): k is TraitKey => (TRAIT_KEYS as readonly string[]).includes(k)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    entries: entries.map(rowToEntry),
  };
}

export async function listGroups(): Promise<ActionResult<TravelGroupSummary[]>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const { data, error } = await session.supabase
    .from("travel_groups")
    .select(`id, name, notes, description, updated_at, group_entries(count)`)
    .order("updated_at", { ascending: false });
  if (error) return fail("failed");
  return {
    ok: true,
    data: data.map((row) => ({
      id: row.id,
      name: row.name,
      notes: row.notes ?? undefined,
      description: row.description ?? undefined,
      entryCount: row.group_entries[0]?.count ?? 0,
      updatedAt: row.updated_at,
    })),
  };
}

async function loadGroup(
  supabase: NonNullable<Awaited<ReturnType<typeof getUserSession>>>["supabase"],
  id: string,
): Promise<ActionResult<TravelGroup>> {
  // Both reads only need the id: one round. A missing group still answers not_found whatever the entries read did.
  const [{ data: group, error }, { data: entries, error: entriesError }] = await Promise.all([
    supabase.from("travel_groups").select(GROUP_COLUMNS).eq("id", id).maybeSingle(),
    supabase.from("group_entries").select(ENTRY_COLUMNS).eq("group_id", id).order("position", { ascending: true }),
  ]);
  if (error) return fail("failed");
  if (!group) return fail("not_found");
  if (entriesError) return fail("failed");
  return { ok: true, data: toGroup(group, entries as GroupEntryRow[]) };
}

export async function getGroup(id: string): Promise<ActionResult<TravelGroup>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  return loadGroup(session.supabase, id);
}

/** Reloads the group; when its description has no parse yet, asks Haiku once (best effort) and reloads. */
async function loadGroupParsed(
  session: NonNullable<Awaited<ReturnType<typeof getUserSession>>>,
  id: string,
): Promise<ActionResult<TravelGroup>> {
  const res = await loadGroup(session.supabase, id);
  if (!res.ok || !res.data.description || res.data.parse) return res;
  const saved = await ensureGroupParse(session, { table: "travel_groups", id }, res.data.description, false);
  return saved ? loadGroup(session.supabase, id) : res;
}

/** Creates a group with its entries (array order = display order). */
export async function createGroup(input: TravelGroupInput): Promise<ActionResult<TravelGroup>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const parsed = TravelGroupInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));

  const { data: group, error } = await session.supabase
    .from("travel_groups")
    .insert({
      name: parsed.data.name,
      notes: parsed.data.notes ?? null,
      description: parsed.data.description ?? null,
      trait_keys: parsed.data.traitKeys,
    })
    .select("id")
    .single();
  if (error) return fail("failed");

  if (parsed.data.entries.length > 0) {
    const today = todayIso();
    const rows = parsed.data.entries.map((entry, index) => ({
      // New group: ignore client-supplied ids.
      ...entryToRow(withStrippedTraits({ ...entry, id: undefined }, parsed.data.traitKeys), index, today),
      group_id: group.id,
    }));
    const { error: entriesError } = await session.supabase.from("group_entries").insert(rows);
    if (entriesError) {
      // PostgREST has no multi-statement transaction: compensate.
      await session.supabase.from("travel_groups").delete().eq("id", group.id);
      return fail("failed");
    }
  }

  await logEvent({
    event: "group.created",
    userId: session.userId,
    props: { groupId: group.id, entries: parsed.data.entries.length },
  });
  return loadGroupParsed(session, group.id);
}

/**
 * Replaces name, notes and entries. Entries with an `id` of this group are
 * updated, entries without are inserted, missing ones are deleted.
 */
export async function updateGroup(
  id: string,
  input: TravelGroupInput,
): Promise<ActionResult<TravelGroup>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const parsed = TravelGroupInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const { supabase } = session;

  const { data: existing, error: existingError } = await supabase
    .from("group_entries")
    .select("id, age_mode, age, age_as_of")
    .eq("group_id", id);
  if (existingError) return fail("failed");
  const existingById = new Map(existing.map((row) => [row.id, row]));

  const keptIds = new Set<string>();
  for (const entry of parsed.data.entries) {
    if (entry.id) {
      if (!existingById.has(entry.id) || keptIds.has(entry.id)) return fail("invalid");
      keptIds.add(entry.id);
    }
  }

  const today = todayIso();
  const entries = parsed.data.entries.map((entry, index) =>
    entryToRow(withStrippedTraits(entry, parsed.data.traitKeys), index, today, entry.id ? existingById.get(entry.id) : undefined),
  );
  // One transaction in the database (security invoker, RLS applies): group + entries or nothing.
  const { error } = await supabase.rpc("replace_group_entries", {
    p_group_id: id,
    p_group: {
      name: parsed.data.name,
      notes: parsed.data.notes ?? null,
      description: parsed.data.description ?? null,
      trait_keys: parsed.data.traitKeys,
    },
    p_entries: entries,
  });
  if (error) return fail(error.code === "P0002" ? "not_found" : error.code === "22023" ? "invalid" : "failed");
  return loadGroupParsed(session, id);
}

export async function deleteGroup(id: string): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const { data, error } = await session.supabase
    .from("travel_groups")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return fail("failed");
  if (data.length === 0) return fail("not_found");
  return { ok: true };
}

/** Reorders entries: `orderedEntryIds` must contain exactly the ids of the group's entries. */
export async function reorderGroupEntries(
  groupId: string,
  orderedEntryIds: string[],
): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const parsed = z.object({ groupId: Id, ids: z.array(Id).max(30) }).safeParse({
    groupId,
    ids: orderedEntryIds,
  });
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const { supabase } = session;

  const { data: existing, error } = await supabase
    .from("group_entries")
    .select("id")
    .eq("group_id", parsed.data.groupId);
  if (error) return fail("failed");
  const existingIds = new Set(existing.map((row) => row.id));
  const given = new Set(parsed.data.ids);
  if (given.size !== parsed.data.ids.length || given.size !== existingIds.size || ![...given].every((i) => existingIds.has(i))) {
    return fail("invalid");
  }

  const { error: reorderError } = await supabase.rpc("reorder_group_entries", {
    p_group_id: parsed.data.groupId,
    p_ids: parsed.data.ids,
  });
  if (reorderError) return fail(reorderError.code === "22023" ? "invalid" : "failed");
  return { ok: true };
}
