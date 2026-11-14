"use server";

import { z } from "zod";
import { STOP_INFO_LOCALES, type StopInfoLocale, type StopInfoView } from "@/lib/domain/stop-info";
import { TourInput } from "@/lib/domain/tour";
import { eligibleStops, storedView, type StopPointRef } from "@/lib/stop-info/view";
import { berlinMidnight } from "../ai-usage";
import { logEvent } from "../events";
import { rateLimit } from "../rate-limit";
import { getUserSession } from "../session";
import { hashShareToken, isShareTokenFormat } from "../share-token";
import { createSupabaseAdminClient } from "../supabase/admin";
import { fetchStopInfoBatch } from "./fetch";

/**
 * Stop info on the first expand (docs/specs/city-tour-stop-info.md sections 5 and 12). Readers of a tour (owner and
 * grantees through RLS, or a share-link viewer by token) get the stored info; when stops are pending, one batch is
 * fetched for all of them, within durable daily limits reserved before the batch, and merged atomically by
 * `merge_stop_info`. Nothing is fetched on render or with a computation; only this action triggers a batch.
 */
export type StopInfoResult = { ok: true; data: StopInfoView } | { ok: false; error: "unauthenticated" | "invalid" | "not_found" | "failed" };

const Id = z.string().uuid();
const USER_DAILY_BATCHES = 60;
const LINK_DAILY_BATCHES = 30;
const APP_DAILY_BATCHES = 2000;
const BURST_PER_MIN = 10;

type TourRowLite = { id: string; owner_id: string; input: unknown; stop_info: unknown };
type Scope = { user: string } | { link: string };

async function ownerLocale(admin: ReturnType<typeof createSupabaseAdminClient>, ownerId: string): Promise<StopInfoLocale | null> {
  const { data, error } = await admin.from("profiles").select("locale").eq("id", ownerId).maybeSingle<{ locale: string }>();
  if (error || !data) return null;
  return (STOP_INFO_LOCALES as readonly string[]).includes(data.locale) ? (data.locale as StopInfoLocale) : null;
}

async function viewFor(row: TourRowLite, scope: Scope, ctxUser: string | null, via: "session" | "share"): Promise<StopInfoResult> {
  const input = TourInput.safeParse(row.input);
  if (!input.success) return { ok: false, error: "invalid" };
  const admin = createSupabaseAdminClient();
  const locale = await ownerLocale(admin, row.owner_id);
  if (!locale) return { ok: false, error: "failed" };
  const eligible = eligibleStops(input.data);
  const first = storedView(row.stop_info, eligible, locale);
  if (first.pending.length === 0) return { ok: true, data: { locale, ...first, limited: false } };

  const burstKey = "user" in scope ? `stop-info:${scope.user}` : `stop-info-link:${scope.link}`;
  const reserved = rateLimit(burstKey, BURST_PER_MIN, 60_000).ok ? await reserve(admin, scope) : null;
  const pendingPoints: StopPointRef[] = eligible.filter((p) => first.pending.includes(p.key));
  const limited = !reserved;
  let calls = 0;
  try {
    // A used-up limit means cache-only (spec 12): cached API answers are still turned into cards, no request is sent.
    const batch = await fetchStopInfoBatch(pendingPoints, locale, { userId: ctxUser }, limited ? offlineClock() : undefined);
    calls = batch.calls;
    if (batch.entries.length) {
      const { error } = await admin.rpc("merge_stop_info", { p_tour: row.id, p_entries: batch.entries, p_locale: locale });
      if (error) throw error;
    }
    await logEvent({
      event: "tour.stop_info",
      userId: ctxUser ?? undefined,
      props: { via, stops: pendingPoints.length, entries: batch.entries.length, unfinished: batch.unfinished.length, calls, limited },
    });
  } catch (err) {
    await logEvent({ event: "tour.stop_info_failed", level: "error", userId: ctxUser ?? undefined, props: { via, message: String(err).slice(0, 200) } });
  } finally {
    if (reserved) await admin.rpc(calls > 0 ? "stop_info_settle" : "stop_info_release", { p_id: reserved });
  }

  const { data: fresh } = await admin.from("city_tours").select("stop_info").eq("id", row.id).maybeSingle<{ stop_info: unknown }>();
  const after = storedView(fresh?.stop_info ?? row.stop_info, eligible, locale);
  return { ok: true, data: { locale, ...after, limited } };
}

/** Clock for a cache-only batch: no network request is allowed. */
function offlineClock() {
  return { deadline: Date.now() + 4000, now: Date.now, offline: true };
}

/** One reserved batch slot (per user or per link, plus app-wide), or null when a daily limit is used up. */
async function reserve(admin: ReturnType<typeof createSupabaseAdminClient>, scope: Scope): Promise<string | null> {
  const { data, error } = await admin.rpc("stop_info_reserve", {
    p_user: "user" in scope ? scope.user : null,
    p_link: "link" in scope ? scope.link : null,
    p_scope_limit: "user" in scope ? USER_DAILY_BATCHES : LINK_DAILY_BATCHES,
    p_app_limit: APP_DAILY_BATCHES,
    p_day_start: berlinMidnight(new Date()).toISOString(),
  });
  if (error) return null; // fail closed: cache-only
  const r = data as { ok?: boolean; id?: string } | null;
  return r?.ok && r.id ? r.id : null;
}

/** Owner or grantee (RLS read). */
export async function getTourStopInfo(tourId: string): Promise<StopInfoResult> {
  try {
    const session = await getUserSession();
    if (!session) return { ok: false, error: "unauthenticated" };
    if (!Id.safeParse(tourId).success) return { ok: false, error: "invalid" };
    const { data: row, error } = await session.supabase
      .from("city_tours")
      .select("id, owner_id, input, stop_info")
      .eq("id", tourId)
      .maybeSingle<TourRowLite>();
    if (error) return { ok: false, error: "failed" };
    if (!row) return { ok: false, error: "not_found" };
    return await viewFor(row, { user: session.userId }, session.userId, "session");
  } catch {
    return { ok: false, error: "failed" };
  }
}

/**
 * Share-link viewer: the link must be valid, same owner, and either a trip link whose trip the tour is linked to, or a
 * link for exactly this standalone tour (spec city-tour 9.3).
 */
export async function getSharedTourStopInfo(token: string, tourId: string): Promise<StopInfoResult> {
  try {
    if (!isShareTokenFormat(token) || !Id.safeParse(tourId).success) return { ok: false, error: "not_found" };
    const admin = createSupabaseAdminClient();
    const { data: link, error } = await admin
      .from("share_links")
      .select("id, owner_id, trip_id, tour_id, expires_at")
      .eq("token_hash", hashShareToken(token))
      .maybeSingle<{ id: string; owner_id: string; trip_id: string | null; tour_id: string | null; expires_at: string | null }>();
    if (error || !link) return { ok: false, error: "not_found" };
    if (link.expires_at !== null && Date.parse(link.expires_at) <= Date.now()) return { ok: false, error: "not_found" };
    const { data: owner } = await admin.from("profiles").select("disabled_at").eq("id", link.owner_id).maybeSingle<{ disabled_at: string | null }>();
    if (!owner || owner.disabled_at) return { ok: false, error: "not_found" };
    let q = admin.from("city_tours").select("id, owner_id, input, stop_info").eq("id", tourId).eq("owner_id", link.owner_id);
    if (link.trip_id) q = q.eq("trip_id", link.trip_id);
    else if (link.tour_id !== tourId) return { ok: false, error: "not_found" };
    const { data: row } = await q.maybeSingle<TourRowLite>();
    if (!row) return { ok: false, error: "not_found" };
    return await viewFor(row, { link: link.id }, null, "share");
  } catch {
    return { ok: false, error: "failed" };
  }
}
