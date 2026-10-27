"use server";

import { z } from "zod";
import {
  TravelGroupInput,
  type TravelGroup,
  type TravelGroupSummary,
} from "@/lib/domain/group";
import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
import { logEvent } from "./events";
import { entryToRow, rowToEntry, type GroupEntryRow } from "./group-mapping";
import { getUserSession, todayIso } from "./session";

const Id = z.string().uuid();
const GROUP_COLUMNS = "id, name, notes, created_at, updated_at";
const ENTRY_COLUMNS =
  "id, group_id, kind, position, count, label, name, is_self, birthdate, age_mode, age, age_as_of, notes, traits";

type GroupRow = {
  id: string;
  name: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

function toGroup(row: GroupRow, entries: GroupEntryRow[]): TravelGroup {
  return {
    id: row.id,
    name: row.name,
    notes: row.notes ?? undefined,
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
    .select(`${GROUP_COLUMNS}, group_entries(count)`)
    .order("updated_at", { ascending: false });
  if (error) return fail("failed");
  return {
    ok: true,
    data: data.map((row) => ({
      id: row.id,
      name: row.name,
      notes: row.notes ?? undefined,
      entryCount: row.group_entries[0]?.count ?? 0,
      updatedAt: row.updated_at,
    })),
  };
}

async function loadGroup(
  supabase: NonNullable<Awaited<ReturnType<typeof getUserSession>>>["supabase"],
  id: string,
): Promise<ActionResult<TravelGroup>> {
  const { data: group, error } = await supabase
    .from("travel_groups")
    .select(GROUP_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("failed");
  if (!group) return fail("not_found");
  const { data: entries, error: entriesError } = await supabase
    .from("group_entries")
    .select(ENTRY_COLUMNS)
    .eq("group_id", id)
    .order("position", { ascending: true });
  if (entriesError) return fail("failed");
  return { ok: true, data: toGroup(group, entries as GroupEntryRow[]) };
}

export async function getGroup(id: string): Promise<ActionResult<TravelGroup>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  return loadGroup(session.supabase, id);
}

/** Creates a group with its entries (array order = display order). */
export async function createGroup(input: TravelGroupInput): Promise<ActionResult<TravelGroup>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const parsed = TravelGroupInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));

  const { data: group, error } = await session.supabase
    .from("travel_groups")
    .insert({ name: parsed.data.name, notes: parsed.data.notes ?? null })
    .select("id")
    .single();
  if (error) return fail("failed");

  if (parsed.data.entries.length > 0) {
    const today = todayIso();
    const rows = parsed.data.entries.map((entry, index) => ({
      // New group: ignore client-supplied ids.
      ...entryToRow({ ...entry, id: undefined }, index, today),
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
  return loadGroup(session.supabase, group.id);
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

  const { data: updated, error } = await supabase
    .from("travel_groups")
    .update({ name: parsed.data.name, notes: parsed.data.notes ?? null })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return fail("failed");
  if (!updated) return fail("not_found");

  // Delete first so a replaced "self" entry cannot collide with the unique index.
  const removedIds = existing.filter((row) => !keptIds.has(row.id)).map((row) => row.id);
  if (removedIds.length > 0) {
    const { error: deleteError } = await supabase.from("group_entries").delete().in("id", removedIds);
    if (deleteError) return fail("failed");
  }

  const today = todayIso();
  const rows = parsed.data.entries.map((entry, index) => ({
    ...entryToRow(entry, index, today, entry.id ? existingById.get(entry.id) : undefined),
    group_id: id,
  }));
  if (rows.length > 0) {
    // Update existing entries one by one, insert the new ones in a batch.
    const inserts = rows.filter((row) => !row.id);
    const updates = rows.filter((row) => row.id);
    for (const row of updates) {
      const { id: entryId, group_id: _group, ...patch } = row;
      void _group;
      const { error: updateError } = await supabase
        .from("group_entries")
        .update(patch)
        .eq("id", entryId!)
        .eq("group_id", id);
      if (updateError) return fail("failed");
    }
    if (inserts.length > 0) {
      const { error: insertError } = await supabase.from("group_entries").insert(inserts);
      if (insertError) return fail("failed");
    }
  }
  return loadGroup(supabase, id);
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

  const results = await Promise.all(
    parsed.data.ids.map((entryId, position) =>
      supabase
        .from("group_entries")
        .update({ position })
        .eq("id", entryId)
        .eq("group_id", parsed.data.groupId),
    ),
  );
  return results.some((r) => r.error) ? fail("failed") : { ok: true };
}
