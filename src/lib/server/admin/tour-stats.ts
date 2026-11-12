import "server-only";
import { createSupabaseAdminClient } from "../supabase/admin";

/** Tours created and computed in the last 7 days (spec city-tour 11, admin "Usage"): two counts, no content. */
export type TourStats = { created7: number; computed7: number };

export const WEEK_MS = 7 * 86_400_000;

/**
 * Counts `tour.created` / `tour.computed` in `app_events`. SECRET KEY (RLS bypass) on purpose: `app_events` has no
 * user grants and these are aggregate counts. Only called by `getAdminDashboard` after `requireAdmin()`.
 * Throws when a count cannot be read (the dashboard then shows the row as missing, not 0).
 */
export async function getTourStats(now: Date = new Date()): Promise<TourStats> {
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  const admin = createSupabaseAdminClient();
  const count = async (event: string) => {
    const { count: n, error } = await admin
      .from("app_events")
      .select("id", { count: "exact", head: true })
      .eq("event", event)
      .gte("created_at", since);
    if (error) throw new Error("tour stats read failed");
    return n ?? 0;
  };
  const [created7, computed7] = await Promise.all([count("tour.created"), count("tour.computed")]);
  return { created7, computed7 };
}
