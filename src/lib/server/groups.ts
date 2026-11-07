"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { berlinToday } from "@/lib/date";
import {
  TRAIT_KEYS,
  TravelGroupInput,
  type GroupEntry,
  type GroupOwner,
  type TraitKey,
  type TravelGroup,
  type TravelGroupSummary,
} from "@/lib/domain/group";
import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
import { accessOf, type ShareAccess } from "@/lib/domain/sharing";
import { safeAgeOn, stripTraits } from "@/lib/group";
import { logEvent } from "./events";
import { ensureGroupParse } from "./group-text";
import { cachedParse, entryToRow, rowToEntry, withViewerLinks, type GroupEntryRow } from "./group-mapping";
import { loadGroupOwnerBirthdate } from "./owner-context";
import { getUserSession, todayIso } from "./session";
import { loadContacts } from "./share-contacts";

const Id = z.string().uuid();
// `group_shares(grantee_id, access)`: RLS gives a recipient their own row, the owner every grant (access mapping, count).
const GROUP_COLUMNS =
  "id, owner_id, name, notes, description, parsed_structure, parsed_hash, trait_keys, created_at, updated_at, group_shares(grantee_id, access)";
const ENTRY_COLUMNS =
  "id, group_id, kind, position, count, label, name, is_self, birthdate, age_mode, age, age_as_of, notes, traits, linked_user_id";
const INSUFFICIENT_PRIVILEGE = "42501"; // entry guard trigger or a policy refusal (owner_only, linked_entry)
const SERIALIZATION_FAILURE = "40001"; // replace_group_entries: stale p_expected_updated_at

type Session = NonNullable<Awaited<ReturnType<typeof getUserSession>>>;

type GroupRow = {
  id: string;
  owner_id: string;
  name: string;
  notes: string | null;
  description: string | null;
  parsed_structure: unknown;
  parsed_hash: string | null;
  trait_keys: string[];
  created_at: string;
  updated_at: string;
  group_shares: { grantee_id: string; access: ShareAccess }[] | null;
};

function withStrippedTraits<E extends GroupEntry>(entry: E, traitKeys: TraitKey[]): E {
  return { ...entry, traits: stripTraits(entry.traits, traitKeys) };
}

/** The viewer's share row of a group (RLS shows a recipient only their own), or undefined. */
const shareOf = (row: Pick<GroupRow, "group_shares">, viewerId: string) => row.group_shares?.find((s) => s.grantee_id === viewerId);

/**
 * The group owner as a recipient sees them (decision A, docs/specs/group-sharing.md 1.2). The birthdate leaves the server
 * only when the group has an `is_self` entry; without one at most the age goes along (needed for "about my age").
 */
async function ownerView(ownerId: string, hasSelfEntry: boolean): Promise<GroupOwner> {
  const ctx = await loadGroupOwnerBirthdate(ownerId); // secret key, after the group was read through RLS
  const birthdate = ctx?.birthdate ?? null;
  return {
    id: ownerId,
    name: ctx?.displayName ?? null,
    birthdate: hasSelfEntry ? birthdate : null,
    ageToday: birthdate ? safeAgeOn(birthdate, berlinToday()) : null,
  };
}

async function toGroup(session: Session, row: GroupRow, entryRows: GroupEntryRow[]): Promise<TravelGroup> {
  const viewer = session.userId;
  const isOwner = row.owner_id === viewer;
  const share = shareOf(row, viewer);
  const access = accessOf(row.owner_id, viewer, share?.access);
  const stored = entryRows.map(rowToEntry);

  // Owner view: the display name of linked people (never an email, share_contacts returns "" for strangers).
  let names = new Map<string, string | null>();
  if (isOwner && stored.some((e) => e.linkedUserId)) {
    const contacts = await loadContacts(session.supabase as SupabaseClient);
    if (contacts) names = new Map([...contacts].map(([id, p]) => [id, p.name]));
  }
  const linked = withViewerLinks(stored, viewer, row.owner_id, names);
  const hasSelfEntry = stored.some((e) => e.kind === "member" && e.isSelf);

  return {
    id: row.id,
    name: row.name,
    notes: row.notes ?? undefined,
    description: row.description ?? undefined,
    parse: cachedParse(row.description, row.parsed_structure, row.parsed_hash),
    traitKeys: row.trait_keys.filter((k): k is TraitKey => (TRAIT_KEYS as readonly string[]).includes(k)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    entries: linked.entries,
    ownerId: row.owner_id,
    access,
    // A group readable only through a shared trip has no share row of the viewer: visible, not pickable (spec 1.1).
    usable: isOwner || share !== undefined,
    owner: isOwner ? null : await ownerView(row.owner_id, hasSelfEntry),
    myEntryId: linked.myEntryId,
  };
}

export async function listGroups(): Promise<ActionResult<TravelGroupSummary[]>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const { data, error } = await session.supabase
    .from("travel_groups")
    .select(`id, name, notes, description, updated_at, group_entries(count), share_count:group_shares(count)`)
    // RLS also returns shared groups and the groups of trips shared with the user: "mine" filters by owner (spec 3.4);
    // groups shared with the user come from listSharedWithMe.
    .eq("owner_id", session.userId)
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
      access: "owner" as const,
      sharedBy: null,
      shareCount: (row as { share_count?: { count: number }[] }).share_count?.[0]?.count ?? 0,
    })),
  };
}

async function loadGroup(session: Session, id: string): Promise<ActionResult<TravelGroup>> {
  const { supabase } = session;
  // Both reads only need the id: one round. A missing group still answers not_found whatever the entries read did.
  const [{ data: group, error }, { data: entries, error: entriesError }] = await Promise.all([
    supabase.from("travel_groups").select(GROUP_COLUMNS).eq("id", id).maybeSingle(),
    supabase.from("group_entries").select(ENTRY_COLUMNS).eq("group_id", id).order("position", { ascending: true }),
  ]);
  if (error) return fail("failed");
  if (!group) return fail("not_found");
  if (entriesError) return fail("failed");
  return { ok: true, data: await toGroup(session, group as GroupRow, entries as GroupEntryRow[]) };
}

export async function getGroup(id: string): Promise<ActionResult<TravelGroup>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  return loadGroup(session, id);
}

/**
 * Reloads the group; when its description has no parse yet, asks Haiku once (best effort) and reloads. The parse is
 * stored on the OWNER's row (a write grantee edits it, spec 3.4); the AI call stays charged to the acting user.
 */
async function loadGroupParsed(session: Session, id: string): Promise<ActionResult<TravelGroup>> {
  const res = await loadGroup(session, id);
  if (!res.ok || !res.data.description || res.data.parse) return res;
  const saved = await ensureGroupParse(session, { table: "travel_groups", id, ownerId: res.data.ownerId }, res.data.description, false);
  return saved ? loadGroup(session, id) : res;
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

/** The viewer's access to a group through RLS: `not_found` when invisible. */
async function accessTo(session: Session, id: string): Promise<{ ok: true; ownerId: string; access: ReturnType<typeof accessOf> } | ReturnType<typeof fail>> {
  const { data, error } = await session.supabase
    .from("travel_groups")
    .select("owner_id, group_shares(grantee_id, access)")
    .eq("id", id)
    .maybeSingle<Pick<GroupRow, "owner_id" | "group_shares">>();
  if (error) return fail("failed");
  if (!data) return fail("not_found");
  return { ok: true, ownerId: data.owner_id, access: accessOf(data.owner_id, session.userId, shareOf(data, session.userId)?.access) };
}

type ExistingEntry = { id: string; kind: string; is_self: boolean; linked_user_id: string | null; age_mode: GroupEntryRow["age_mode"]; age: number | null; age_as_of: string | null };

/**
 * What a write grantee may not do to the entries, checked before the RPC for a clear answer (the guard trigger enforces
 * the same, docs/specs/group-sharing.md 2.5): keep the owner's `is_self` entry as it is, add no `is_self` entry, keep
 * entries linked to someone else (they may not be deleted or made ineligible).
 */
function writeGranteeMayApply(existing: ExistingEntry[], payload: GroupEntry[], viewerId: string): boolean {
  const self = existing.find((e) => e.is_self);
  if (self) {
    const kept = payload.find((e) => e.id === self.id);
    if (!kept || kept.kind !== "member" || !kept.isSelf) return false;
  }
  if (payload.some((e) => e.kind === "member" && e.isSelf && (!e.id || e.id !== self?.id))) return false;
  for (const row of existing) {
    if (!row.linked_user_id || row.linked_user_id === viewerId) continue;
    const kept = payload.find((e) => e.id === row.id);
    if (!kept || kept.kind !== "member" || kept.isSelf) return false;
  }
  return true;
}

/**
 * Replaces name, notes and entries. Entries with an `id` of this group are updated, entries without are inserted,
 * missing ones are deleted. A read grantee gets `forbidden`; a write grantee is limited by `writeGranteeMayApply`.
 * `expectedUpdatedAt`: the `updatedAt` the form was loaded with; a different stored value means someone else changed the
 * group meanwhile: `conflict` (spec 3.5). Omitted = no check ("Save anyway").
 */
export async function updateGroup(
  id: string,
  input: TravelGroupInput,
  expectedUpdatedAt?: string,
): Promise<ActionResult<TravelGroup>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const parsed = TravelGroupInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const expected = z.string().datetime({ offset: true }).optional().safeParse(expectedUpdatedAt);
  if (!expected.success) return fail("invalid", zodIssues(expected.error));
  const { supabase } = session;

  const access = await accessTo(session, id);
  if (!access.ok) return access;
  if (access.access === "read") return fail("forbidden");

  const { data: existing, error: existingError } = await supabase
    .from("group_entries")
    .select("id, kind, is_self, linked_user_id, age_mode, age, age_as_of")
    .eq("group_id", id);
  if (existingError) return fail("failed");
  const existingById = new Map((existing as ExistingEntry[]).map((row) => [row.id, row]));

  const keptIds = new Set<string>();
  for (const entry of parsed.data.entries) {
    if (entry.id) {
      if (!existingById.has(entry.id) || keptIds.has(entry.id)) return fail("invalid");
      keptIds.add(entry.id);
    }
  }
  if (access.access === "write" && !writeGranteeMayApply(existing as ExistingEntry[], parsed.data.entries, session.userId)) {
    return fail("forbidden");
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
    ...(expectedUpdatedAt !== undefined ? { p_expected_updated_at: expectedUpdatedAt } : {}),
  });
  if (error) {
    if (error.code === SERIALIZATION_FAILURE) return fail("conflict");
    if (error.code === INSUFFICIENT_PRIVILEGE) return fail("forbidden");
    return fail(error.code === "P0002" ? "not_found" : error.code === "22023" ? "invalid" : "failed");
  }
  return loadGroupParsed(session, id);
}

export async function deleteGroup(id: string): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  // RLS: only the owner can delete; a grantee's delete matches no row (not_found).
  const { data, error } = await session.supabase
    .from("travel_groups")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return fail("failed");
  if (data.length === 0) return fail("not_found");
  return { ok: true };
}

/** Reorders entries: `orderedEntryIds` must contain exactly the ids of the group's entries. Read grantees: `forbidden`. */
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

  const access = await accessTo(session, parsed.data.groupId);
  if (!access.ok) return access;
  if (access.access === "read") return fail("forbidden");

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
  if (reorderError) {
    if (reorderError.code === INSUFFICIENT_PRIVILEGE) return fail("forbidden");
    return fail(reorderError.code === "22023" ? "invalid" : "failed");
  }
  return { ok: true };
}
