import "server-only";
import { TourInput, TourResult, type Tour, type TourSummary } from "@/lib/domain/tour";
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
};

export const TOUR_COLUMNS =
  "id, owner_id, title, input, trip_id, trip_day, result, result_hash, computed_at, created_at, updated_at";

/**
 * Stored row → `Tour`, or null when the stored input is not a valid `TourInput` (the column is user-writable over
 * PostgREST, so it is parsed like external data). An invalid stored result is treated as none.
 */
export function rowToTour(row: TourRow, viewerId: string): Tour | null {
  const input = TourInput.safeParse(row.input);
  if (!input.success) return null;
  const result = row.result == null ? null : TourResult.safeParse(row.result);
  const valid = result?.success ? result.data : null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    access: row.owner_id === viewerId ? "owner" : "read",
    title: row.title,
    input: input.data,
    tripId: row.trip_id,
    tripDay: row.trip_id ? row.trip_day : null,
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
