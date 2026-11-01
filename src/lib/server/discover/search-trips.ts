import "server-only";
import { z } from "zod";
import { getUserSession } from "../session";

const Id = z.string().uuid();

/**
 * Trips made from one saved list, as `geoId -> trip id` (newest first wins), so the list can mark cards that
 * already have a trip and link to it (spec section 7). RLS limits this to the caller's own trips.
 */
export async function tripsOfSearch(searchId: string): Promise<Record<string, string>> {
  if (!Id.safeParse(searchId).success) return {};
  const session = await getUserSession();
  if (!session) return {};
  const { data, error } = await session.supabase
    .from("trips")
    .select("id, dest_geo_id")
    .eq("destination_search_id", searchId)
    .not("dest_geo_id", "is", null)
    .order("created_at", { ascending: false })
    .returns<{ id: string; dest_geo_id: number }[]>();
  if (error || !data) return {};
  const out: Record<string, string> = {};
  for (const row of data) if (!(String(row.dest_geo_id) in out)) out[String(row.dest_geo_id)] = row.id;
  return out;
}
