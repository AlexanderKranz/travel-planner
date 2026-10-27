"use server";

import { z } from "zod";
import { PurposeGuided, TripPurposeInput, type TripPurpose } from "@/lib/domain/purpose";
import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
import { logEvent } from "./events";
import { getUserSession } from "./session";

const COLUMNS = "id, name, text, guided, constraints, created_at, updated_at";
const Id = z.string().uuid();

type PurposeRow = {
  id: string;
  name: string;
  text: string | null;
  guided: unknown;
  constraints: string[];
  created_at: string;
  updated_at: string;
};

function rowToPurpose(row: PurposeRow): TripPurpose {
  const guided = PurposeGuided.safeParse(row.guided);
  return {
    id: row.id,
    name: row.name,
    text: row.text ?? undefined,
    guided: guided.success ? guided.data : {},
    constraints: row.constraints,
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
  return { ok: true, data: rowToPurpose(data) };
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
