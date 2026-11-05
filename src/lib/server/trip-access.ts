import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Access } from "@/lib/domain/sharing";
import { tripAccess, type TripRow } from "./trip-mapping";

/**
 * The viewer's access to a trip, read with the USER session (RLS): owner, the level of their share row, or null when the
 * trip is not visible to them (unknown id, no share, or a disabled owner). One query: the embedded share rows are the
 * viewer's own (or all grants when they own the trip).
 */
export async function getTripAccess(sb: SupabaseClient, tripId: string, viewerId: string): Promise<Access | null> {
  const { data, error } = await sb
    .from("trips")
    .select("owner_id, trip_shares(grantee_id, access)")
    .eq("id", tripId)
    .maybeSingle<Pick<TripRow, "owner_id" | "trip_shares">>();
  if (error) throw new Error("trip access read failed");
  return data ? tripAccess(data, viewerId) : null;
}

/** The trip an item belongs to (RLS: only items of visible trips), or null. */
export async function getItemTripId(sb: SupabaseClient, itemId: string): Promise<string | null> {
  const { data, error } = await sb.from("trip_items").select("trip_id").eq("id", itemId).maybeSingle<{ trip_id: string }>();
  if (error) throw new Error("item read failed");
  return data?.trip_id ?? null;
}
