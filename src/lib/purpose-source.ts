import { oneOffPurpose } from "@/lib/discover/one-off";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";

/**
 * The purpose a trip uses: the saved one (by `purposeId`), else its one-off text, else null (spec trip-purpose-text P5).
 * The one-off purpose is transient (id ""), never in `trip_purposes`, and `usable: false` so no UI offers to open it.
 * It carries the trip's owner and access, and the trip's `updatedAt` for both timestamps, like the one-off group.
 */
export function tripPurpose(
  trip: Pick<Trip, "ownerId" | "access" | "purposeId" | "purposeText" | "purposeTags" | "updatedAt">,
  saved: TripPurpose | null,
): TripPurpose | null {
  if (trip.purposeId) return saved;
  if (!trip.purposeText) return null;
  return {
    ...oneOffPurpose(trip.purposeText, trip.purposeTags ?? null),
    ownerId: trip.ownerId,
    access: trip.access,
    usable: false,
    createdAt: trip.updatedAt,
    updatedAt: trip.updatedAt,
  };
}

/** True for the transient purpose of `tripPurpose` / a typed search (not a saved one). */
export const isOneOffPurpose = (p: TripPurpose): boolean => p.id === "";
