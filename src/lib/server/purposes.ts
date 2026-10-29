"use server";

import { z } from "zod";
import { PurposeTags } from "@/lib/domain/plan";
import { PurposeGuided, TripPurposeInput, type TripPurpose } from "@/lib/domain/purpose";
import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
import { purposeTagsHash } from "@/lib/plan/hash";
import { logEvent } from "./events";
import { externalWriteAllowed } from "./rate-limit";
import { getUserSession } from "./session";
import { schedulePurposeWarm } from "./warm";

const COLUMNS = "id, name, text, guided, constraints, parsed_tags, parsed_hash, created_at, updated_at";
const Id = z.string().uuid();

type PurposeRow = {
  id: string;
  name: string;
  text: string | null;
  guided: unknown;
  constraints: string[];
  parsed_tags: unknown;
  parsed_hash: string | null;
  created_at: string;
  updated_at: string;
};

/** Tags count only while the hash of the current content matches (edited purposes are re-tagged). */
function rowTags(row: PurposeRow, guided: PurposeGuided): TripPurpose["tags"] {
  if (row.parsed_tags == null || !row.parsed_hash) return null;
  try {
    const hash = purposeTagsHash({ text: row.text ?? undefined, constraints: row.constraints, guided });
    if (hash !== row.parsed_hash) return null;
  } catch {
    return null;
  }
  const tags = PurposeTags.safeParse(row.parsed_tags);
  return tags.success ? tags.data : null;
}

function rowToPurpose(row: PurposeRow): TripPurpose {
  const guided = PurposeGuided.safeParse(row.guided);
  const guidedData = guided.success ? guided.data : {};
  return {
    id: row.id,
    name: row.name,
    text: row.text ?? undefined,
    guided: guidedData,
    constraints: row.constraints,
    tags: rowTags(row, guidedData),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listPurposes(): Promise<ActionResult<TripPurpose[]>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const { data, error } = await session.supabase
    .from("trip_purposes")
    .select(COLUMNS)
    .order("updated_at", { ascending: false });
  if (error) return fail("failed");
  return { ok: true, data: data.map(rowToPurpose) };
}

export async function getPurpose(id: string): Promise<ActionResult<TripPurpose>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const { data, error } = await session.supabase
    .from("trip_purposes")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("failed");
  if (!data) return fail("not_found");
  return { ok: true, data: rowToPurpose(data) };
}

export async function createPurpose(input: TripPurposeInput): Promise<ActionResult<TripPurpose>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const parsed = TripPurposeInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  if (!externalWriteAllowed(session.userId)) return fail("rate_limited");

  // owner_id is filled by its column default (auth.uid()); RLS checks it.
  const { data, error } = await session.supabase
    .from("trip_purposes")
    .insert({
      name: parsed.data.name,
      text: parsed.data.text ?? null,
      guided: parsed.data.guided,
      constraints: parsed.data.constraints,
    })
    .select(COLUMNS)
    .single();
  if (error) return fail("failed");
  await logEvent({
    event: "purpose.created",
    userId: session.userId,
    props: { purposeId: data.id, constraints: parsed.data.constraints.length },
  });
  return { ok: true, data: rowToPurpose(data) };
}

export async function updatePurpose(
  id: string,
  input: TripPurposeInput,
): Promise<ActionResult<TripPurpose>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const parsed = TripPurposeInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  if (!externalWriteAllowed(session.userId)) return fail("rate_limited");

  const { data, error } = await session.supabase
    .from("trip_purposes")
    .update({
      name: parsed.data.name,
      text: parsed.data.text ?? null,
      guided: parsed.data.guided,
      constraints: parsed.data.constraints,
    })
    .eq("id", id)
    .select(COLUMNS)
    .maybeSingle();
  if (error) return fail("failed");
  if (!data) return fail("not_found");
  const purpose = rowToPurpose(data);
  // New content → new tags → other places: refresh tags and places for trips using it in the background.
  if (purpose.tags == null) await schedulePurposeWarm(session, purpose.id);
  return { ok: true, data: purpose };
}

export async function deletePurpose(id: string): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const { data, error } = await session.supabase
    .from("trip_purposes")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return fail("failed");
  if (data.length === 0) return fail("not_found");
  return { ok: true };
}
