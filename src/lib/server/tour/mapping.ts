import "server-only";
import { accessOf } from "@/lib/domain/sharing";
import { TourInput, TourResult, type Tour, type TourAccess, type TourSummary } from "@/lib/domain/tour";
import { tourInputHash } from "@/lib/tour/hash";

/** Row of `public.city_tours` (migration 20261116120041). */
export type TourRow = {
  id: string;
  owner_id: string;
  title: string | null;
  input: unknown;
  trip_id: string | null;
  trip_day: number | null;
  result: unknown;
  result_hash: string | null;
  computed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Through RLS: the owner sees every share row of the tour, a grantee only their own (migration 20261120120045). */
  tour_shares?: { grantee_id: string; access: "read" | "write" }[] | null;
};

export const TOUR_COLUMNS =
  "id, owner_id, title, input, trip_id, trip_day, result, result_hash, computed_at, created_at, updated_at, tour_shares(grantee_id, access)";

/** Owner, else the level of the viewer's own tour share, else `read` (a tour seen through a shared trip). */
export function tourAccess(row: Pick<TourRow, "owner_id" | "tour_shares">, viewerId: string): TourAccess {
  const share = row.tour_shares?.find((s) => s.grantee_id === viewerId);
  return accessOf(row.owner_id, viewerId, share?.access ?? null);
}

/**
 * Stored row → `Tour`, or null when the stored input is not a valid `TourInput` (the column is user-writable over
 * PostgREST, so it is parsed like external data). An invalid stored result is treated as none.
 */
export function rowToTour(row: TourRow, viewerId: string): Tour | null {
  const input = TourInput.safeParse(row.input);
  if (!input.success) return null;
  const result = row.result == null ? null : TourResult.safeParse(row.result);
  const valid = result?.success ? result.data : null;
  // A tour shared directly does not carry the owner's trip along: its link and day stay hidden from the grantee
  // (city-tour 9.3). Grantees of the trip itself (no tour share row) keep them.
  const direct = row.owner_id !== viewerId && !!row.tour_shares?.some((s) => s.grantee_id === viewerId);
  const tripId = direct ? null : row.trip_id;
  return {
    id: row.id,
    ownerId: row.owner_id,
    access: tourAccess(row, viewerId),
    title: row.title,
    input: input.data,
    tripId,
    tripDay: tripId ? row.trip_day : null,
    result: valid,
    computedAt: row.computed_at,
    outdated: !valid || row.result_hash !== tourInputHash(input.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function tourToSummary(t: Tour): TourSummary {
  return {
    id: t.id,
    access: t.access,
    title: t.title,
    city: t.input.city?.name ?? null,
    firstPlace: t.input.places[0]?.name ?? null,
    placeCount: t.input.places.length,
    mode: t.input.mode,
    tripId: t.tripId,
    tripDay: t.tripDay,
    startTime: t.input.startTime ?? null,
    totalMin: t.result?.totalMin ?? null,
    computedAt: t.computedAt,
    outdated: t.outdated,
    updatedAt: t.updatedAt,
  };
}
