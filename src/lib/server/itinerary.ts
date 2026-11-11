"use server";

import type { ItineraryContext, ItineraryExtractInput, ItineraryExtractResult } from "@/lib/domain/itinerary";

/**
 * AI extraction of an itinerary the browser parser could not read (docs/specs/itinerary-upload.md section 3.4).
 * `tripId` is null for a trip that is not saved yet; with an id the caller needs write access (`canEdit`).
 * Never writes to the trip: the result is a proposal for the form ([D7]).
 * STUB: the extraction work replaces this body. Signature is the contract.
 */
export async function extractItinerary(
  _tripId: string | null,
  _input: ItineraryExtractInput,
  _ctx: ItineraryContext,
): Promise<ItineraryExtractResult> {
  return { ok: false, error: "failed" };
}

/**
 * Stops derived from the saved trip notes ([D10]) for the form's "Übernehmen" row: parser first, Haiku only on a
 * miss (cached). Empty when the trip has confirmed stops, no notes, or the caller cannot read the trip.
 * STUB: the extraction work replaces this body. Signature is the contract.
 */
export async function derivedTripStops(_tripId: string): Promise<import("@/lib/domain/trip-stops").TripStop[]> {
  return [];
}
