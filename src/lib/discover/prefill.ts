import { emptyTripDraft, ONE_OFF_PURPOSE, type TripDraft } from "@/components/trips/trip-draft";
import type { DestinationSearch, SuggestionCard } from "@/lib/domain/destination-search";
import { cleanReason } from "./reason";

/**
 * The trip form draft for a tapped suggestion (spec section 7 [D11]). Nothing is created by this.
 * - `title` stays empty and `notes` never gets the reason: the reason is an AI guess and `trip.notes` goes verbatim into
 *   the plan input as the user's own facts, so it is never copied into the trip.
 * - an unsaved typed one-off (`purposeText` set, no `purposeId`) becomes the trip's one-off purpose text, `notes` stay
 *   empty (trip-purpose-text P8, supersedes find-destinations 13.5). A saved or linked purpose leaves the text empty.
 * - coordinates are not part of the draft; `createTrip` resolves them from `geoId`.
 * - `lengthDays` stays at the form default.
 * - a drive search gives `wantsFlights: false` and no airports, explicitly (the search has none; the guard keeps it
 *   so if that ever changes). The drive itself is not copied into the trip; the user can still switch flights on.
 */
export function buildTripDraft(
  search: Pick<DestinationSearch, "id" | "months" | "origins" | "purposeId" | "groupId"> & {
    travelMode?: DestinationSearch["travelMode"];
    purposeText?: DestinationSearch["purposeText"];
  },
  card: Pick<SuggestionCard, "kind" | "geoId" | "placeName" | "name" | "admin1">,
  profileHomeAirports: readonly string[],
  /**
   * Ids of the purposes the user may still use (own and shared with them, `TripPurpose.usable`). A purpose that is no
   * longer in the list (unshared in another tab) gives an empty `purposeId`, as for a deleted purpose, so `createTrip`
   * does not end in `not_found`. Omitted = no check (callers without the list).
   */
  usablePurposeIds?: readonly string[],
  /**
   * Ids of the groups the user may still use (own and shared with them). A group that is no longer in the list (unshared
   * or left meanwhile) gives an empty `groupId`, as for purposes. Omitted = no check.
   */
  usableGroupIds?: readonly string[],
): TripDraft {
  const base = emptyTripDraft();
  const profileFirstTwo = profileHomeAirports.slice(0, 2);
  const sameAsProfile = search.origins.length === profileFirstTwo.length && search.origins.every((o, i) => o === profileFirstTwo[i]);
  const unsavedOneOff = search.purposeId === null && !!search.purposeText;
  const hasOrigins = search.travelMode !== "drive" && search.origins.length > 0;
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
    groupId: search.groupId && (!usableGroupIds || usableGroupIds.includes(search.groupId)) ? search.groupId : "",
    purposeId: search.purposeId && (!usablePurposeIds || usablePurposeIds.includes(search.purposeId)) ? search.purposeId : "",
    ...(unsavedOneOff ? { purposeId: ONE_OFF_PURPOSE, purposeText: search.purposeText! } : {}),
    wantsFlights: hasOrigins,
    useHomeAirports: !hasOrigins || sameAsProfile,
    originAirports: hasOrigins && !sameAsProfile ? [...search.origins] : [],
    destinationSearchId: search.id,
  };
}
