import type { ItineraryContext, ItineraryParseResult } from "@/lib/domain/itinerary";

/**
 * Line-based itinerary parser (docs/specs/itinerary-upload.md section 3.3) on prefiltered text. Pure; browser and
 * server (trip notes). Maps dates to trip days with `ctx` and sets the section 3.5 flags.
 * STUB: the extraction work replaces this body. Signature is the contract.
 */
export function parseItinerary(_text: string, _ctx: ItineraryContext): ItineraryParseResult {
  return { stops: [], usable: false };
}
