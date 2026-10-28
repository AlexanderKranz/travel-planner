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
import { ITEM_COLUMNS, itemToWrite, rowToItem, type ItemRow } from "./item-mapping";
import { getUserSession } from "./session";

const Id = z.string().uuid();
const Status = z.enum(ITEM_STATUSES);
const FK_VIOLATION = "23503"; // trip of another user (or unknown) fails the composite FK

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
  if (error) return fail(error.code === FK_VIOLATION ? "not_found" : "failed");
  return { ok: true, data: rowToItem(data) };
}

export async function updateItem(id: string, input: unknown): Promise<ActionResult<TripItem>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const parsed = TripItemInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
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
  const { data, error } = await session.supabase.from("trip_items").update({ status }).eq("id", id).select("id");
  if (error) return fail("failed");
  if (!data || data.length === 0) return fail("not_found");
  return { ok: true };
}

export async function deleteItem(id: string): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const { data, error } = await session.supabase.from("trip_items").delete().eq("id", id).select("id");
  if (error) return fail("failed");
  if (!data || data.length === 0) return fail("not_found");
  return { ok: true };
}
