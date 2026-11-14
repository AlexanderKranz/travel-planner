import "server-only";
import type { Locale } from "@/lib/domain/profile";
import { TourStopInfo } from "@/lib/domain/stop-info";
import type { Tour } from "@/lib/domain/tour";
import { logEvent } from "../events";
import { hashShareToken, isShareTokenFormat } from "../share-token";
import { createSupabaseAdminClient } from "../supabase/admin";
import { rowToTour, type TourRow } from "./mapping";

/**
 * PUBLIC read path of a link for a standalone city tour (spec city-tour 9.3, migration 20261120120045). Like
 * `getSharedPlanDocument`: the visitor has no session, possession of the token grants access (only its sha256 is
 * stored), the secret key reads exactly one tour of the link's owner, with explicit columns (never `*`): no owner name,
 * no email, no share rows, no trip link. Every failure returns null so the page renders one identical 404 (unknown,
 * expired, revoked, disabled owner, trip link, missing or uncomputed tour). No external API calls.
 */
export type SharedTour = {
  linkId: string;
  /** Read-only view of the stored snapshot; `access` is always "read". */
  tour: Tour;
  /** The owner's language: the page and the PDF are shown in it. */
  locale: Locale;
  /** Stored stop info, only when asked for (PDF opt-in "Ortsinfos aufnehmen"); else null. */
  stopInfo: TourStopInfo | null;
};

const SHARED_TOUR_COLUMNS = "id, owner_id, title, input, trip_id, trip_day, result, result_hash, computed_at, created_at, updated_at";

type LinkRow = { id: string; owner_id: string; tour_id: string | null; expires_at: string | null };

/** The valid tour link for `token`, or null (also for a trip link). Shared by the page, the PDF and stop info. */
export async function resolveTourLink(token: string): Promise<LinkRow & { tour_id: string; locale: Locale } | null> {
  if (!isShareTokenFormat(token)) return null;
  const admin = createSupabaseAdminClient();
  const { data: link, error } = await admin
    .from("share_links")
    .select("id, owner_id, tour_id, expires_at")
    .eq("token_hash", hashShareToken(token))
    .maybeSingle<LinkRow>();
  if (error || !link || !link.tour_id) return null;
  if (link.expires_at !== null && Date.parse(link.expires_at) <= Date.now()) return null;
  // A disabled owner's links answer like an unknown token; fails closed when the flag cannot be read.
  const { data: owner, error: ownerErr } = await admin
    .from("profiles")
    .select("disabled_at, locale")
    .eq("id", link.owner_id)
    .maybeSingle<{ disabled_at: string | null; locale: Locale }>();
  if (ownerErr || !owner || owner.disabled_at) return null;
  return { ...link, tour_id: link.tour_id, locale: owner.locale };
}

export async function getSharedTour(token: string, via: "page" | "pdf", opts: { stopInfo?: boolean } = {}): Promise<SharedTour | null> {
  try {
    const link = await resolveTourLink(token);
    if (!link) return null;
    const admin = createSupabaseAdminClient();
    const { data: row, error } = await admin
      .from("city_tours")
      .select(opts.stopInfo ? `${SHARED_TOUR_COLUMNS}, stop_info` : SHARED_TOUR_COLUMNS)
      .eq("id", link.tour_id)
      .eq("owner_id", link.owner_id)
      .maybeSingle<TourRow & { stop_info?: unknown }>();
    if (error || !row) return null;
    // The visitor is nobody: viewerId "" never equals an owner id, so access is "read".
    const parsed = rowToTour({ ...row, trip_id: null, trip_day: null, tour_shares: [] }, "");
    if (!parsed || !parsed.result) return null;
    await Promise.allSettled([
      Promise.resolve(admin.rpc("share_link_touch", { p_id: link.id })),
      logEvent({ event: "share.viewed", userId: link.owner_id, props: { linkId: link.id, via, kind: "tour" } }),
    ]);
    // Nothing that names the owner or the trip leaves this function.
    const info = opts.stopInfo ? TourStopInfo.safeParse(row.stop_info) : null;
    return {
      linkId: link.id,
      tour: { ...parsed, ownerId: "", tripId: null, tripDay: null },
      locale: link.locale,
      stopInfo: info?.success ? info.data : null,
    };
  } catch {
    return null;
  }
}
