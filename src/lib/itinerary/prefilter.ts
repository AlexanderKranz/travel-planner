import { MAX_ITINERARY_TEXT } from "@/lib/domain/itinerary";

/**
 * Keeps only itinerary-like lines (dates, weekdays, day numbers, times, sea-day words) plus one neighbour line each,
 * capped at MAX_ITINERARY_TEXT (docs/specs/itinerary-upload.md section 3.2). Pure; browser and server.
 * STUB: the extraction work replaces this body. Signature is the contract.
 */
export function prefilterItinerary(text: string): string {
  return text.slice(0, MAX_ITINERARY_TEXT);
}
