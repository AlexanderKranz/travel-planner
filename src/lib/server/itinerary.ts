"use server";

import { z } from "zod";
import { berlinToday } from "@/lib/date";
import {
  ItineraryContext,
  ItineraryExtractInput,
  type ItineraryExtractResult,
  type ItineraryPath,
} from "@/lib/domain/itinerary";
import { canEdit } from "@/lib/domain/sharing";
import { tripStops, type TripStop } from "@/lib/domain/trip-stops";
import { mapStops } from "@/lib/itinerary/map";
import { parseItinerary } from "@/lib/itinerary/parse";
import { prefilterItinerary } from "@/lib/itinerary/prefilter";
import type { ItineraryPayload } from "./ai/itinerary-extract";
import { logEvent } from "./events";
import { checkImages, runItineraryAi } from "./itinerary-ai";
import { deriveNotesStops } from "./itinerary-notes";
import { getUserSession } from "./session";
import { rowToTrip, tripAccess, TRIP_COLUMNS_WITH_SHARES, type TripRow } from "./trip-mapping";

const Id = z.string().uuid();

/**
 * AI extraction of an itinerary the browser parser could not read (docs/specs/itinerary-upload.md section 3.4).
 * `tripId` is null for a trip that is not saved yet; with an id the caller needs write access (`canEdit`).
 * Never writes to the trip: the result is a proposal for the form ([D7]).
 *
 * - Text: prefiltered again on the server (whatever the client sent, only itinerary lines reach the model), then the
 *   parser (0 tokens) in case the client skipped it, then Haiku. Places and times must occur in the text.
 * - Images: base64, at most 3, each at most 2 MB with matching magic bytes; every stop is flagged `from_image`.
 * - AI cost goes to the acting user; the cache row (`itinerary_extracts`) to the trip owner (the acting user for an
 *   unsaved trip). Gates in `runItineraryAi` ([D9]).
 */
export async function extractItinerary(
  tripId: string | null,
  input: ItineraryExtractInput,
  ctx: ItineraryContext,
): Promise<ItineraryExtractResult> {
  const session = await getUserSession();
  if (!session) return { ok: false, error: "forbidden" };
  const parsedInput = ItineraryExtractInput.safeParse(input);
  const parsedCtx = ItineraryContext.safeParse(ctx);
  if (!parsedInput.success || !parsedCtx.success) return { ok: false, error: "invalid" };
  const data = parsedInput.data;
  const c = parsedCtx.data;

  let ownerId = session.userId;
  if (tripId !== null) {
    if (!Id.safeParse(tripId).success) return { ok: false, error: "invalid" };
    const { data: row, error } = await session.supabase
      .from("trips")
      .select("owner_id, trip_shares(grantee_id, access)")
      .eq("id", tripId)
      .maybeSingle<Pick<TripRow, "owner_id" | "trip_shares">>();
    if (error || !row || !canEdit(tripAccess(row, session.userId))) return { ok: false, error: "forbidden" };
    ownerId = row.owner_id;
  }

  const today = berlinToday();
  let payload: ItineraryPayload;
  if (data.kind === "text") {
    const text = prefilterItinerary(data.text);
    if (!text) return noStops(session.userId);
    const parsed = parseItinerary(text, c, today);
    if (parsed.usable) return done(session.userId, "parser", parsed.stops, 0);
    payload = { kind: "text", text };
  } else {
    if (!checkImages(data.images)) return { ok: false, error: "invalid" };
    payload = { kind: "images", images: data.images };
  }

  const run = await runItineraryAi(session, ownerId, payload);
  if (!run.ok) return { ok: false, error: run.error };
  const stops = mapStops(run.extract.stops, c, today);
  if (stops.length === 0) return noStops(session.userId);
  return done(session.userId, payload.kind === "text" ? "text_ai" : "image_ai", stops, payload.kind === "images" ? payload.images.length : 0);
}

async function noStops(userId: string): Promise<ItineraryExtractResult> {
  await logEvent({ event: "itinerary.extract_failed", userId, props: { reason: "no_stops" } });
  return { ok: false, error: "no_stops" };
}

async function done(
  userId: string,
  path: ItineraryPath,
  stops: Extract<ItineraryExtractResult, { ok: true }>["stops"],
  pages: number,
): Promise<ItineraryExtractResult> {
  // Counts only, never places or text.
  await logEvent({
    event: "itinerary.extracted",
    userId,
    props: { path, source: "upload", stops: stops.length, flagged: stops.filter((s) => s.flags.length > 0).length, pages },
  });
  return { ok: true, path, stops };
}

/**
 * Stops derived from the saved trip notes ([D10]) for the form's "Übernehmen" row: parser first, Haiku only on a
 * miss (cached). Empty when the trip has confirmed stops, no notes, or the caller cannot read the trip. A read
 * grantee gets parser and cached results only (no AI call is charged to someone who cannot edit).
 */
export async function derivedTripStops(tripId: string): Promise<TripStop[]> {
  const session = await getUserSession();
  if (!session || !Id.safeParse(tripId).success) return [];
  const { data: row, error } = await session.supabase
    .from("trips")
    .select(TRIP_COLUMNS_WITH_SHARES)
    .eq("id", tripId)
    .maybeSingle<TripRow>();
  if (error || !row) return [];
  const trip = rowToTrip(row, session.userId);
  if ((trip.stops && trip.stops.length > 0) || !trip.notes) return [];
  const derived = await deriveNotesStops(trip, { session, allowAi: canEdit(trip.access) });
  return tripStops(trip, derived);
}
