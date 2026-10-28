import {
  DEFAULT_RADIUS_KM,
  type Destination,
  type Trip,
  type TripInputParsed,
  type TripSummary,
  type TripTiming,
} from "@/lib/domain/trip";
import type { GeoPlace } from "@/lib/domain/geo";

/** snake_case row of public.trips (the columns the app reads and writes). */
export type TripRow = {
  id: string;
  title: string | null;
  dest_kind: "city" | "region" | "freetext";
  dest_name: string;
  dest_place_name: string | null;
  dest_geo_id: number | null;
  dest_country_code: string | null;
  dest_admin1: string | null;
  dest_lat: number | null;
  dest_lon: number | null;
  dest_timezone: string | null;
  dest_radius_km: number | null;
  length_days: number;
  start_date: string | null;
  months: number[];
  group_id: string | null;
  purpose_id: string | null;
  wants_flights: boolean;
  origin_airports: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export const TRIP_COLUMNS =
  "id, title, dest_kind, dest_name, dest_place_name, dest_geo_id, dest_country_code, dest_admin1, dest_lat, dest_lon, dest_timezone, dest_radius_km, length_days, start_date, months, group_id, purpose_id, wants_flights, origin_airports, notes, created_at, updated_at";

/** The writable columns (everything except id, owner_id and the timestamps). */
export type TripWrite = Omit<TripRow, "id" | "created_at" | "updated_at">;

export function rowToDestination(row: TripRow): Destination {
  if (
    row.dest_kind === "freetext" ||
    row.dest_lat === null ||
    row.dest_lon === null ||
    row.dest_geo_id === null
  ) {
    return { kind: "freetext", name: row.dest_name, countryCode: row.dest_country_code };
  }
  return {
    kind: row.dest_kind,
    name: row.dest_name,
    placeName: row.dest_place_name ?? row.dest_name,
    geoId: Number(row.dest_geo_id),
    countryCode: row.dest_country_code,
    admin1: row.dest_admin1,
    lat: row.dest_lat,
    lon: row.dest_lon,
    timezone: row.dest_timezone,
    radiusKm: row.dest_radius_km ?? DEFAULT_RADIUS_KM[row.dest_kind],
  };
}

export function rowToTiming(row: Pick<TripRow, "start_date" | "months">): TripTiming {
  if (row.start_date) return { kind: "date", startDate: row.start_date };
  if (row.months.length > 0) return { kind: "months", months: row.months };
  return { kind: "none" };
}

export function rowToTrip(row: TripRow): Trip {
  return {
    id: row.id,
    title: row.title ?? undefined,
    destination: rowToDestination(row),
    lengthDays: row.length_days,
    timing: rowToTiming(row),
    groupId: row.group_id,
    purposeId: row.purpose_id,
    wantsFlights: row.wants_flights,
    originAirports: row.origin_airports,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type NamedRef = { name: string } | null;
export type TripSummaryRow = TripRow & {
  travel_groups: NamedRef;
  trip_purposes: NamedRef;
};

export function rowToSummary(row: TripSummaryRow): TripSummary {
  const trip = rowToTrip(row);
  return {
    id: trip.id,
    title: trip.title,
    destination: trip.destination,
    lengthDays: trip.lengthDays,
    timing: trip.timing,
    updatedAt: trip.updatedAt,
    groupName: row.travel_groups?.name ?? null,
    purposeName: row.trip_purposes?.name ?? null,
  };
}

/**
 * Builds the full write set. Geocoded fields come ONLY from `place` (the server-side
 * lookup), never from the client. `place` must be given for city/region and is ignored
 * for freetext. Always returns every column so an update also clears fields of the old kind.
 */
export function buildTripWrite(input: TripInputParsed, place: GeoPlace | null): TripWrite {
  const d = input.destination;
  const geo =
    d.kind === "freetext" || !place
      ? {
          dest_place_name: null,
          dest_geo_id: null,
          dest_admin1: null,
          dest_lat: null,
          dest_lon: null,
          dest_timezone: null,
          dest_radius_km: null,
        }
      : {
          dest_place_name: place.name,
          dest_geo_id: place.geoId,
          dest_admin1: place.admin1,
          dest_lat: place.lat,
          dest_lon: place.lon,
          dest_timezone: place.timezone,
          dest_radius_km: d.radiusKm ?? null,
        };
  const countryCode = d.kind === "freetext" ? (d.countryCode ?? null) : (place?.countryCode ?? null);
  const name = d.kind === "freetext" ? d.name : (d.name ?? place?.name ?? "");
  const t = input.timing;
  return {
    title: input.title ?? null,
    dest_kind: d.kind,
    dest_name: name,
    dest_country_code: countryCode,
    ...geo,
    length_days: input.lengthDays,
    start_date: t.kind === "date" ? t.startDate : null,
    months: t.kind === "months" ? t.months : [],
    group_id: input.groupId,
    purpose_id: input.purposeId,
    wants_flights: input.wantsFlights,
    origin_airports: input.originAirports,
    notes: input.notes ?? null,
  };
}

/** Did a change affect what the facts depend on (destination, timing, purpose)? */
export function factsInputsChanged(before: TripRow, after: TripWrite): boolean {
  return (
    before.dest_kind !== after.dest_kind ||
    before.dest_geo_id !== after.dest_geo_id ||
    before.dest_radius_km !== after.dest_radius_km ||
    before.dest_country_code !== after.dest_country_code ||
    before.start_date !== after.start_date ||
    before.length_days !== after.length_days ||
    before.months.join(",") !== after.months.join(",") ||
    before.purpose_id !== after.purpose_id
  );
}
