import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LinkedTour } from "@/lib/plan/tour-blocks";
import { rowToTour, type TourRow } from "./mapping";

/**
 * City tours linked to a trip, for the plan (input, guard, day blocks) and the plan document (city-tour 10).
 * Explicit columns only; `result_hash` and the owner are not needed by the plan.
 */
export const LINKED_TOUR_COLUMNS = "id, trip_id, trip_day, title, input, result, updated_at";
type LinkedRow = Pick<TourRow, "id" | "trip_id" | "trip_day" | "title" | "input" | "result" | "updated_at">;

/** Stored rows → tours of exactly this trip (rows of another trip are dropped, whatever the query returned). */
export function rowsToLinkedTours(rows: readonly LinkedRow[], tripId: string): LinkedTour[] {
  return rows.flatMap((r) => {
    if (r.trip_id !== tripId) return [];
    const t = rowToTour(
      { ...r, owner_id: "", result_hash: null, computed_at: null, created_at: r.updated_at },
      "",
    );
    return t ? [{ id: t.id, tripDay: t.tripDay, title: t.title, input: t.input, result: t.result, updatedAt: t.updatedAt }] : [];
  });
}

/**
 * Tours linked to the trip. With the user session, RLS decides (owner; grantees of the trip read them). The public
 * share path passes the secret-key client and the link's owner: the read is then filtered by the shared trip id and
 * that owner, never more (ground rule 6). Throws on a read error.
 */
export async function loadLinkedTours(sb: SupabaseClient, tripId: string, ownerId?: string): Promise<LinkedTour[]> {
  let q = sb.from("city_tours").select(LINKED_TOUR_COLUMNS).eq("trip_id", tripId);
  if (ownerId !== undefined) q = q.eq("owner_id", ownerId);
  const { data, error } = await q.returns<LinkedRow[]>();
  if (error) throw new Error("tours read failed");
  return rowsToLinkedTours(data ?? [], tripId);
}
