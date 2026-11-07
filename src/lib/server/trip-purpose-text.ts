import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiCtx } from "@/lib/domain/ai";
import { PurposeTags } from "@/lib/domain/plan";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import { oneOffTagsHash } from "@/lib/discover/one-off";
import { isOneOffPurpose } from "@/lib/purpose-source";
import { tagPurpose } from "./ai/purpose-tags";
import { findTagsByHash } from "./discover/store";
import { logEvent } from "./events";
import { createSupabaseAdminClient } from "./supabase/admin";

/**
 * Caches the Haiku tags of a trip's one-off purpose text on the trip row (spec trip-purpose-text P4). SECRET KEY (RLS
 * bypass) on purpose: users have no grant on purpose_tags* (they could otherwise plant tags that look machine-made),
 * and a write grantee may tag a trip they do not own. The id + owner_id filter (the row's owner, as read through RLS by
 * the caller) keeps the write scoped to that one row.
 * Compare-and-set: it writes only while the stored text is still `text` and the stored tags are not yet for it (hash
 * differs or missing), so a second concurrent tagger (warm step vs. plan run) never overwrites the first result.
 * The trigger does not move trips.updated_at for tag-only writes. Returns true when this call wrote.
 */
export async function saveTripPurposeTags(trip: { id: string; ownerId: string }, tags: PurposeTags, text: string): Promise<boolean> {
  try {
    const hash = oneOffTagsHash(text);
    const { data, error } = await createSupabaseAdminClient()
      .from("trips")
      .update({ purpose_tags: tags, purpose_tags_hash: hash, purpose_tags_at: new Date().toISOString() })
      .eq("id", trip.id)
      .eq("owner_id", trip.ownerId)
      .eq("purpose_text", text)
      .or(`purpose_tags_hash.is.null,purpose_tags_hash.neq.${hash}`)
      .select("id");
    return !error && data.length === 1;
  } catch {
    return false;
  }
}

/** Tags another run stored for exactly this text (user session, RLS), else null. */
async function readStoredTags(sb: SupabaseClient, tripId: string, text: string): Promise<PurposeTags | null> {
  try {
    const { data } = await sb.from("trips").select("purpose_text, purpose_tags, purpose_tags_hash").eq("id", tripId).maybeSingle<{ purpose_text: string | null; purpose_tags: unknown; purpose_tags_hash: string | null }>();
    if (!data || data.purpose_text !== text || data.purpose_tags_hash !== oneOffTagsHash(text)) return null;
    const parsed = PurposeTags.safeParse(data.purpose_tags);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The tagging step for a one-off purpose (`isOneOffPurpose`) of a trip; same wants-tags test as a saved purpose. */
export const wantsTripTags = (p: TripPurpose | null): p is TripPurpose => !!p && isOneOffPurpose(p) && p.tags == null && !!p.text?.trim();

export type TaggedTripPurpose = { purpose: TripPurpose };

/**
 * Tags the one-off purpose of a trip: an earlier result for the same text first (the owner's searches, saved purposes
 * and trips by hash, no Haiku call), else one Haiku call. Saved on the trip row. Never throws and never fails the
 * caller: a failure is logged (`purpose.tag_failed`, no text) and the purpose stays untagged, so the plan falls back to
 * the raw text. Budget checks are the caller's. `actor` pays for the call (through `ctx`); only the trip OWNER's
 * searches/purposes can be looked up (a write grantee cannot read them), so a grantee run always calls Haiku.
 */
export async function tagTripPurpose(
  actor: { userId: string; sb: SupabaseClient },
  trip: Pick<Trip, "id" | "ownerId" | "access">,
  purpose: TripPurpose,
  ctx: AiCtx,
): Promise<TaggedTripPurpose> {
  const unchanged = { purpose };
  const text = purpose.text?.trim();
  if (!text) return unchanged;
  const hash = oneOffTagsHash(text);
  const fail = async (reason: string): Promise<TaggedTripPurpose> => {
    await logEvent({ event: "purpose.tag_failed", level: "warn", userId: actor.userId, props: { source: "trip_text", tripId: trip.id, reason } });
    return unchanged;
  };
  let tags: PurposeTags | null = null;
  if (trip.access === "owner") {
    try {
      tags = (await findTagsByHash(actor.sb, hash, actor.userId))?.tags ?? null;
    } catch {
      return await fail("lookup_failed"); // fail closed: no Haiku call after a failed read
    }
  }
  if (!tags) {
    const res = await tagPurpose(purpose, ctx);
    if (!res.ok) return await fail(res.error);
    tags = res.data;
  }
  const written = await saveTripPurposeTags(trip, tags, text);
  // Lost the compare-and-set: another run stored tags for this text meanwhile. Use those (one set of tags per text).
  if (!written) tags = (await readStoredTags(actor.sb, trip.id, text)) ?? tags;
  return { purpose: { ...purpose, tags } };
}
