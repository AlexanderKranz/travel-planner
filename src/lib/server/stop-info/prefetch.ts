import "server-only";
import { after } from "next/server";
import { STOP_INFO_LOCALES, type StopInfoLocale } from "@/lib/domain/stop-info";
import { TourInput } from "@/lib/domain/tour";
import { eligibleStops, storedView, type StopPointRef } from "@/lib/stop-info/view";
import { tourCentre, tourPointsOf } from "@/lib/tour/points";
import { berlinMidnight } from "../ai-usage";
import { logEvent } from "../events";
import { createSupabaseAdminClient } from "../supabase/admin";
import { readLandmarks } from "../tour/landmarks";
import { osmKeyOf } from "../tour/places";
import { fetchStopInfoBatch } from "./fetch";

/**
 * Stop info in the background (docs/specs/city-tour-stop-info.md, decisions 2026-11-15). After a computation, and when
 * an expand left stops missing or partial, the batch runs after the response with a long budget: public Overpass took
 * 27 s or answered 502 when measured, far beyond the 4 s of the request path. Only stops that are missing, stale or
 * partial are fetched; a recompute with the same stops therefore costs no calls. Daily limits as on expand (owner).
 */
export const BACKGROUND_BUDGET_MS = 110_000;
/** "Infos werden geladen" is shown while a background run for the tour was scheduled this recently (per instance). */
export const PREFETCH_COOLDOWN_MS = 2 * 60_000;
const USER_DAILY_BATCHES = 60;
const APP_DAILY_BATCHES = 2000;

/** Stop key → Wikidata id from the city's cached landmark set (0 external calls; empty when the set is not cached). */
export async function landmarkQids(input: TourInput, ctx: { userId: string | null }): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const centre = input.city ? { lat: input.city.lat, lon: input.city.lon } : tourCentre(input, tourPointsOf(input).points);
  if (!centre) return out;
  try {
    const set = await readLandmarks(centre, ctx);
    for (const l of set?.ranked ?? []) out.set(osmKeyOf(l), l.wikidata);
  } catch {
    // A cache read problem only means no fast path.
  }
  return out;
}

const lastScheduled = new Map<string, number>();

/** Whether a background run for this tour was scheduled within the cooldown (per instance; drives the card text). */
export function prefetchRecentlyScheduled(tourId: string, now: number = Date.now()): boolean {
  const at = lastScheduled.get(tourId);
  return at !== undefined && now - at < PREFETCH_COOLDOWN_MS;
}

/**
 * Schedules `prefetchStopInfo` after the response, at most once per tour and instance per cooldown. Returns whether a
 * run is scheduled (now or recently). Never throws; outside a request scope (no `after`) it returns false.
 */
export function scheduleStopInfoPrefetch(tourId: string, now: number = Date.now()): boolean {
  if (prefetchRecentlyScheduled(tourId, now)) return true;
  try {
    after(async () => {
      await prefetchStopInfo(tourId);
    });
  } catch {
    return false;
  }
  lastScheduled.set(tourId, now);
  if (lastScheduled.size > 500) lastScheduled.delete(lastScheduled.keys().next().value!);
  return true;
}

/** Test hook. */
export function resetPrefetchState(): void {
  lastScheduled.clear();
}

/** One background batch for a tour: missing, stale or partial stops only. Never throws. */
export async function prefetchStopInfo(tourId: string, now: () => number = Date.now): Promise<"done" | "nothing" | "limited" | "failed"> {
  const admin = createSupabaseAdminClient();
  let reserved: string | null = null;
  let calls = 0;
  try {
    const { data: row } = await admin
      .from("city_tours")
      .select("id, owner_id, input, stop_info")
      .eq("id", tourId)
      .maybeSingle<{ id: string; owner_id: string; input: unknown; stop_info: unknown }>();
    if (!row) return "failed";
    const input = TourInput.safeParse(row.input);
    if (!input.success) return "failed";
    const { data: profile } = await admin.from("profiles").select("locale").eq("id", row.owner_id).maybeSingle<{ locale: string }>();
    const locale = profile && (STOP_INFO_LOCALES as readonly string[]).includes(profile.locale) ? (profile.locale as StopInfoLocale) : null;
    if (!locale) return "failed";

    const eligible = eligibleStops(input.data);
    const view = storedView(row.stop_info, eligible, locale, now());
    const wanted = new Set([...view.pending, ...view.incomplete]);
    if (wanted.size === 0) return "nothing";

    const { data: slot, error } = await admin.rpc("stop_info_reserve", {
      p_user: row.owner_id,
      p_link: null,
      p_scope_limit: USER_DAILY_BATCHES,
      p_app_limit: APP_DAILY_BATCHES,
      p_day_start: berlinMidnight(new Date(now())).toISOString(),
    });
    const r = slot as { ok?: boolean; id?: string } | null;
    if (error || !r?.ok || !r.id) return "limited";
    reserved = r.id;

    const points: StopPointRef[] = eligible.filter((p) => wanted.has(p.key));
    const ctx = { userId: row.owner_id };
    const qids = await landmarkQids(input.data, ctx);
    const batch = await fetchStopInfoBatch(points, locale, ctx, { deadline: now() + BACKGROUND_BUDGET_MS, now }, { qids, tags: "all" });
    calls = batch.calls;
    if (batch.entries.length) {
      const { error: mergeError } = await admin.rpc("merge_stop_info", { p_tour: row.id, p_entries: batch.entries, p_locale: locale });
      if (mergeError) throw mergeError;
    }
    await logEvent({
      event: "tour.stop_info_background",
      userId: row.owner_id,
      props: {
        stops: points.length,
        entries: batch.entries.length,
        partial: batch.entries.filter((e) => e.partial).length,
        unfinished: batch.unfinished.length,
        calls,
        fastPath: points.filter((p) => qids.has(p.key)).length,
      },
    });
    return "done";
  } catch (err) {
    await logEvent({ event: "tour.stop_info_failed", level: "error", props: { via: "background", message: String(err).slice(0, 200) } });
    return "failed";
  } finally {
    if (reserved) await admin.rpc(calls > 0 ? "stop_info_settle" : "stop_info_release", { p_id: reserved });
  }
}
