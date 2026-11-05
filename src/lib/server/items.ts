"use server";

import { z } from "zod";
import {
  ITEM_STATUSES,
  MAX_ITEMS_PER_TRIP,
  TripItemInput,
  type ItemStatus,
  type TripItem,
} from "@/lib/domain/items";
import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
import { canEdit } from "@/lib/domain/sharing";
import { ITEM_COLUMNS, itemToWrite, rowToItem, type ItemRow } from "./item-mapping";
import { getUserSession } from "./session";
import { getItemTripId, getTripAccess } from "./trip-access";

const Id = z.string().uuid();
const Status = z.enum(ITEM_STATUSES);
const FK_VIOLATION = "23503"; // trip of another user (or unknown) fails the composite FK

/** SQLSTATE raised by trigger trip_items_cap (migration 22). */
const ITEM_LIMIT_ERRCODE = "TP100";

type Session = NonNullable<Awaited<ReturnType<typeof getUserSession>>>;
type Denied = ReturnType<typeof fail>;

/**
 * Write gate of every item action (spec sharing 3.5): a clear `forbidden` for a read grantee instead of an RLS 0-row
 * miss, `not_found` when the trip (or the item's trip) is not visible at all. RLS still enforces the same on the write.
 */
async function writeGate(session: Session, tripId: string | null): Promise<Denied | null> {
  if (tripId === null) return fail("not_found");
  try {
    const access = await getTripAccess(session.supabase, tripId, session.userId);
    if (access === null) return fail("not_found");
    return canEdit(access) ? null : fail("forbidden");
  } catch {
    return fail("failed");
  }
}

async function itemWriteGate(session: Session, itemId: string): Promise<Denied | null> {
  try {
    return await writeGate(session, await getItemTripId(session.supabase, itemId));
  } catch {
    return fail("failed");
  }
}

export async function listItems(tripId: string): Promise<ActionResult<TripItem[]>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(tripId).success) return fail("invalid");
  const { data, error } = await session.supabase
    .from("trip_items")
    .select(ITEM_COLUMNS)
    .eq("trip_id", tripId)
    .order("day", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .returns<ItemRow[]>();
  if (error) return fail("failed");
  return { ok: true, data: data.map(rowToItem) };
}

export async function createItem(tripId: string, input: unknown): Promise<ActionResult<TripItem>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(tripId).success) return fail("invalid");
  const parsed = TripItemInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const denied = await writeGate(session, tripId);
  if (denied) return denied;

  const { count, error: countError } = await session.supabase
    .from("trip_items")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", tripId);
  if (countError) return fail("failed");
  if ((count ?? 0) >= MAX_ITEMS_PER_TRIP) return fail("limit_reached");

  const { data, error } = await session.supabase
    .from("trip_items")
    .insert({ trip_id: tripId, ...itemToWrite(parsed.data) })
    .select(ITEM_COLUMNS)
    .single<ItemRow>();
  if (error) {
    if (error.code === ITEM_LIMIT_ERRCODE) return fail("limit_reached");
    return fail(error.code === FK_VIOLATION ? "not_found" : "failed");
  }
  return { ok: true, data: rowToItem(data) };
}

export async function updateItem(id: string, input: unknown): Promise<ActionResult<TripItem>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const parsed = TripItemInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const denied = await itemWriteGate(session, id);
  if (denied) return denied;
  const { data, error } = await session.supabase
    .from("trip_items")
    .update(itemToWrite(parsed.data))
    .eq("id", id)
    .select(ITEM_COLUMNS)
    .maybeSingle<ItemRow>();
  if (error) return fail("failed");
  if (!data) return fail("not_found");
  return { ok: true, data: rowToItem(data) };
}

export async function setItemStatus(id: string, status: ItemStatus): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success || !Status.safeParse(status).success) return fail("invalid");
  const denied = await itemWriteGate(session, id);
  if (denied) return denied;
  const { data, error } = await session.supabase.from("trip_items").update({ status }).eq("id", id).select("id");
  if (error) return fail("failed");
  if (!data || data.length === 0) return fail("not_found");
  return { ok: true };
}

export async function deleteItem(id: string): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const denied = await itemWriteGate(session, id);
  if (denied) return denied;
  const { data, error } = await session.supabase.from("trip_items").delete().eq("id", id).select("id");
  if (error) return fail("failed");
  if (!data || data.length === 0) return fail("not_found");
  return { ok: true };
}
