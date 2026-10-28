"use server";

import type { TripItem } from "@/lib/domain/items";
import { ITEM_STATUSES } from "@/lib/domain/items";
import { fail, type ActionResult } from "@/lib/domain/result";
import golfItems from "@/lib/items/__fixtures__/items-golf.json";

/** STUBS (phase 5 step 0). listItems returns the golf fixture; mutations return `failed`. */
export async function listItems(tripId: string): Promise<ActionResult<TripItem[]>> {
  const data = (golfItems as unknown as TripItem[]).map((i) => ({ ...i, tripId }));
  return { ok: true, data };
}
export async function createItem(_tripId: string, _input: unknown): Promise<ActionResult<TripItem>> {
  return fail("failed");
}
export async function updateItem(_id: string, _input: unknown): Promise<ActionResult<TripItem>> {
  return fail("failed");
}
export async function setItemStatus(
  _id: string,
  _status: (typeof ITEM_STATUSES)[number],
): Promise<ActionResult> {
  return fail("failed");
}
export async function deleteItem(_id: string): Promise<ActionResult> {
  return fail("failed");
}
