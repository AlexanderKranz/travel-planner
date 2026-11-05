"use server";

import { z } from "zod";
import { TripPurposeInput, type TripPurpose } from "@/lib/domain/purpose";
import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
import { rowToPurpose } from "./purpose-mapping";
import { logEvent } from "./events";
import { insertPurposeRow, PURPOSE_COLUMNS_WITH_SHARES, type PurposeRow } from "./purpose-insert";
import { externalWriteAllowed } from "./rate-limit";
import { getUserSession } from "./session";
import { schedulePurposeWarm } from "./warm";

const Id = z.string().uuid();
const INSUFFICIENT_PRIVILEGE = "42501";

export async function listPurposes(): Promise<ActionResult<TripPurpose[]>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const { data, error } = await session.supabase
    .from("trip_purposes")
    .select(PURPOSE_COLUMNS_WITH_SHARES)
    // RLS also returns purposes shared with the user and purposes seen through a shared trip: "mine" filters by owner.
    // Usable shared purposes come from listSharedWithMe (spec sharing 3.5).
    .eq("owner_id", session.userId)
    .order("updated_at", { ascending: false })
    .returns<PurposeRow[]>();
  if (error) return fail("failed");
  return { ok: true, data: data.map((row) => rowToPurpose(row, session.userId)) };
}

export async function getPurpose(id: string): Promise<ActionResult<TripPurpose>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const { data, error } = await session.supabase
    .from("trip_purposes")
    .select(PURPOSE_COLUMNS_WITH_SHARES)
    .eq("id", id)
    .maybeSingle<PurposeRow>();
  if (error) return fail("failed");
  if (!data) return fail("not_found");
  return { ok: true, data: rowToPurpose(data, session.userId) };
}

export async function createPurpose(input: TripPurposeInput): Promise<ActionResult<TripPurpose>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const parsed = TripPurposeInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  if (!externalWriteAllowed(session.userId)) return fail("rate_limited");

  const { data, error } = await insertPurposeRow(session.supabase, parsed.data);
  if (error) return fail("failed");
  await logEvent({
    event: "purpose.created",
    userId: session.userId,
    props: { purposeId: data.id, constraints: parsed.data.constraints.length },
  });
  return { ok: true, data: rowToPurpose(data, session.userId) };
}

/**
 * `expectedUpdatedAt`: the `updatedAt` the form was loaded with; a different stored value means someone else changed the
 * purpose meanwhile: `conflict` (spec sharing 3.6). Omitted = no check. A read grantee gets `forbidden`.
 */
export async function updatePurpose(
  id: string,
  input: TripPurposeInput,
  expectedUpdatedAt?: string,
): Promise<ActionResult<TripPurpose>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const parsed = TripPurposeInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  if (!externalWriteAllowed(session.userId)) return fail("rate_limited");

  // Read first (RLS): a purpose the user cannot see is `not_found`; a visible one they may not edit is `forbidden`.
  const { data: before, error: readError } = await session.supabase
    .from("trip_purposes")
    .select(PURPOSE_COLUMNS_WITH_SHARES)
    .eq("id", id)
    .maybeSingle<PurposeRow>();
  if (readError) return fail("failed");
  if (!before) return fail("not_found");
  const current = rowToPurpose(before, session.userId);
  if (current.access === "read") return fail("forbidden");
  if (expectedUpdatedAt !== undefined && before.updated_at !== expectedUpdatedAt) return fail("conflict");

  let query = session.supabase
    .from("trip_purposes")
    .update({
      name: parsed.data.name,
      text: parsed.data.text ?? null,
      guided: parsed.data.guided,
      constraints: parsed.data.constraints,
    })
    .eq("id", id);
  if (expectedUpdatedAt !== undefined) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select(PURPOSE_COLUMNS_WITH_SHARES).maybeSingle<PurposeRow>();
  if (error) return fail(error.code === INSUFFICIENT_PRIVILEGE ? "forbidden" : "failed");
  // The row was readable a moment ago: no row back means somebody changed it in between.
  if (!data) return fail(expectedUpdatedAt !== undefined ? "conflict" : "not_found");
  const purpose = rowToPurpose(data, session.userId);
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
