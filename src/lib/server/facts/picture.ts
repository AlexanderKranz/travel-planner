import "server-only";
import type { FactsCtx } from "@/lib/domain/facts";
import { DestinationPicture, type DestinationPictureResult } from "@/lib/domain/picture";
import type { Trip } from "@/lib/domain/trip";
import { fetchWikibaseItem } from "@/lib/integrations/wikipedia";
import { fetchCommonsFiles, fetchImageClaims } from "@/lib/integrations/wikimedia-images";
import { choosePicture } from "@/lib/facts/picture";
import { cacheKey, cached, peekCache } from "../api-cache";
import { createSupabaseAdminClient } from "../supabase/admin";
import { hashShareToken, isShareTokenFormat } from "../share-token";
import { geoDestination } from "./common";

const pictureSchema = DestinationPicture.nullable();

/** A banner or main image changes rarely; "no picture" is cached for the same time so it is not refetched. */
const TTL_SECONDS = 60 * 86400;
const KEY_VERSION = 1;

/** Language-independent on purpose: the owner's locale only steers the page lookup, the share page reads the same entry. */
const pictureKey = (geoId: number) => cacheKey("picture", KEY_VERSION, { geo: geoId });

/**
 * Cold lookup. The de and en Wikipedia pages are both resolved (by coordinates, in parallel) because they can be
 * different Wikidata items: de "Tokio" is the metropolis (Q7473516, no banner), en "Tokyo" the city (Q1490, with
 * banner). Banners of any resolved item win over main images; the owner's language goes first.
 * A failed request throws (not cached) unless another one already found an item.
 */
export async function lookupDestinationPicture(lat: number, lon: number, placeName: string, lang: "de" | "en") {
  const order = lang === "de" ? (["de", "en"] as const) : (["en", "de"] as const);
  const items = await Promise.allSettled(order.map((l) => fetchWikibaseItem(lat, lon, placeName, l)));
  const found = items.flatMap((i) => (i.status === "fulfilled" && i.value.qid ? [i.value.qid] : []));
  const failed = items.find((i) => i.status === "rejected");
  if (found.length === 0 && failed?.status === "rejected") throw failed.reason;
  let latency = Math.max(0, ...items.map((i) => (i.status === "fulfilled" ? i.value.latencyMs : 0)));
  if (found.length === 0) return { data: null, status: 200, latencyMs: latency };
  const qids = [...new Set(found)];
  const claims = await Promise.all(qids.map((q) => fetchImageClaims(q)));
  latency += Math.max(...claims.map((c) => c.latencyMs));
  const uniq = (xs: string[]) => [...new Set(xs)];
  const banners = uniq(claims.flatMap((c) => c.banners));
  const images = uniq(claims.flatMap((c) => c.images));
  if (banners.length + images.length === 0) return { data: null, status: 200, latencyMs: latency };
  const commons = await fetchCommonsFiles([...banners, ...images]);
  latency += commons.latencyMs;
  return { data: choosePicture(commons.files, banners, images), status: commons.status, latencyMs: latency };
}

/**
 * Picture of the trip destination for the header of the owner's trip page (stream it in Suspense).
 * Source chain: Wikipedia page by coordinates -> Wikidata item -> P948 (page banner) -> P18 (main image) ->
 * Commons file metadata, filtered by quality and licence (lib/facts/picture.ts). Cached 60 days incl. "none".
 * Freetext destinations, no match and every failure return null (never throws, never blocks the page for long:
 * a cold lookup is 3 to 4 small requests). Not part of the LLM input or the PDF.
 */
export async function getDestinationPicture(trip: Trip, ctx: FactsCtx): Promise<DestinationPictureResult | null> {
  try {
    const dest = geoDestination(trip);
    if (!dest) return null;
    const res = await cached({
      provider: "wikidata",
      endpoint: "picture",
      key: pictureKey(dest.geoId),
      ttlSeconds: TTL_SECONDS,
      schema: pictureSchema,
      ctx,
      fetcher: async () => {
        const r = await lookupDestinationPicture(dest.lat, dest.lon, dest.placeName, ctx.locale === "de" ? "de" : "en");
        return { data: r.data, status: r.status, latencyMs: r.latencyMs };
      },
    });
    return res.ok && res.data ? { ...res.data, fetchedAt: res.fetchedAt } : null;
  } catch (err) {
    console.error("destination picture failed", err instanceof Error ? err.name : "unknown");
    return null;
  }
}

/**
 * Picture for the PUBLIC share page: reads `api_cache` only (ADR 0005: the public path never calls external APIs).
 * Returns null on a cache miss, so a picture appears once the owner's trip page (or the background warm-up after
 * saving the trip) has looked it up. Call it only after `getSharedPlanDocument` returned a document for the same
 * token; it re-resolves token -> trip -> destination geoId with explicit columns and exposes nothing else.
 */
export async function getSharedDestinationPicture(token: string): Promise<DestinationPictureResult | null> {
  if (!isShareTokenFormat(token)) return null;
  try {
    const admin = createSupabaseAdminClient();
    const { data: link } = await admin
      .from("share_links")
      .select("trip_id, owner_id, expires_at")
      .eq("token_hash", hashShareToken(token))
      .maybeSingle<{ trip_id: string; owner_id: string; expires_at: string | null }>();
    if (!link) return null;
    // Same rules as getSharedPlanDocument, so this stays safe on its own: nothing for an expired link or a disabled owner.
    if (link.expires_at !== null && Date.parse(link.expires_at) <= Date.now()) return null;
    const { data: owner, error: ownerErr } = await admin
      .from("profiles")
      .select("disabled_at")
      .eq("id", link.owner_id)
      .maybeSingle<{ disabled_at: string | null }>();
    if (ownerErr || !owner || owner.disabled_at) return null;
    const { data: trip } = await admin
      .from("trips")
      .select("dest_kind, dest_geo_id")
      .eq("id", link.trip_id)
      .maybeSingle<{ dest_kind: string; dest_geo_id: number | string | null }>();
    if (!trip || trip.dest_kind === "freetext" || trip.dest_geo_id === null) return null;
    const hit = await peekCache({ provider: "wikidata", key: pictureKey(Number(trip.dest_geo_id)), schema: pictureSchema });
    return hit?.data ? { ...hit.data, fetchedAt: hit.fetchedAt } : null;
  } catch {
    return null;
  }
}

