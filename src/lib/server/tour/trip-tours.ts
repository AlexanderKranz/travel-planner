import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TourStopInfo } from "@/lib/domain/stop-info";
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
export async function loadLinkedTours(
  sb: SupabaseClient,
  tripId: string,
  ownerId?: string,
  opts: { stopInfo?: boolean } = {},
): Promise<LinkedTour[]> {
  const read = (columns: string) => {
    let q = sb.from("city_tours").select(columns).eq("trip_id", tripId);
    if (ownerId !== undefined) q = q.eq("owner_id", ownerId);
    return q.returns<(LinkedRow & { stop_info?: unknown })[]>();
  };
  let { data, error } = await read(opts.stopInfo ? `${LINKED_TOUR_COLUMNS}, stop_info` : LINKED_TOUR_COLUMNS);
  // Stop info is optional: a failed read with it falls back to the tours alone (never a PDF without its tours).
  if (error && opts.stopInfo) ({ data, error } = await read(LINKED_TOUR_COLUMNS));
  if (error) throw new Error("tours read failed");
  const tours = rowsToLinkedTours(data ?? [], tripId);
  if (!opts.stopInfo) return tours;
  // Stored info only (PDF opt-in): an invalid or missing column value means no lines, never a failed document.
  const infoById = new Map((data ?? []).map((r) => [r.id, TourStopInfo.safeParse(r.stop_info)] as const));
  return tours.map((t) => {
    const parsed = infoById.get(t.id);
    return { ...t, stopInfo: parsed?.success ? parsed.data : null };
  });
}
