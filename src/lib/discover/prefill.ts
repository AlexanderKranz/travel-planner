import { emptyTripDraft, type TripDraft } from "@/components/trips/trip-draft";
import type { DestinationSearch, SuggestionCard } from "@/lib/domain/destination-search";
import { cleanReason } from "./reason";

/**
 * The trip form draft for a tapped suggestion (spec section 7 [D11]). Nothing is created by this.
 * - `title` and `notes` stay empty: the reason is an AI guess and `trip.notes` goes verbatim into the plan input
 *   as the user's own facts, so it is never copied into the trip.
 * - coordinates are not part of the draft; `createTrip` resolves them from `geoId`.
 * - `lengthDays` stays at the form default.
 */
export function buildTripDraft(
  search: Pick<DestinationSearch, "id" | "months" | "origins" | "purposeId" | "groupId">,
  card: Pick<SuggestionCard, "kind" | "geoId" | "placeName" | "name" | "admin1">,
  profileHomeAirports: readonly string[],
): TripDraft {
  const base = emptyTripDraft();
  const profileFirstTwo = profileHomeAirports.slice(0, 2);
  const sameAsProfile = search.origins.length === profileFirstTwo.length && search.origins.every((o, i) => o === profileFirstTwo[i]);
  const hasOrigins = search.origins.length > 0;
  return {
    ...base,
    destination: {
      mode: "geo",
      geoKind: card.kind,
      geoId: card.geoId,
      placeName: card.placeName,
      placeLabel: [card.placeName, card.admin1].filter(Boolean).join(", "),
      // The name is model text: only a clean one is ever carried into a trip (older saved cards are checked again).
      name: cleanReason(card.name).reason ?? card.placeName,
      radiusKm: null,
    },
    timing: search.months.length > 0 ? { mode: "months", startDate: "", months: [...search.months] } : base.timing,
    groupId: search.groupId ?? "",
    purposeId: search.purposeId ?? "",
    wantsFlights: hasOrigins,
    useHomeAirports: !hasOrigins || sameAsProfile,
    originAirports: hasOrigins && !sameAsProfile ? [...search.origins] : [],
    destinationSearchId: search.id,
  };
}
