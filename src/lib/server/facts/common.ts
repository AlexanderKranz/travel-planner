import "server-only";
import type { Fact, SourceId } from "@/lib/domain/facts";
import type { Trip } from "@/lib/domain/trip";
import type { CachedResult } from "../api-cache";

export type GeoDestination = Extract<Trip["destination"], { lat: number }>;

export function geoDestination(trip: Trip): GeoDestination | null {
  return trip.destination.kind === "freetext" ? null : trip.destination;
}

export const unavailable = (
  reason: Extract<Fact<unknown>, { status: "unavailable" }>["reason"],
  source?: SourceId,
): Fact<never> => (source ? { status: "unavailable", reason, source } : { status: "unavailable", reason });

/** Maps a successful cached() result to an ok Fact; failures become provider_error. */
export function toFact<T, D>(
  res: CachedResult<T>,
  source: SourceId,
  map: (data: T) => D,
  sourceUrl?: string,
): Fact<D> {
  if (!res.ok) return unavailable("provider_error", source);
  const base = { status: "ok" as const, data: map(res.data), source, fetchedAt: res.fetchedAt, stale: res.stale };
  return sourceUrl ? { ...base, sourceUrl } : base;
}
