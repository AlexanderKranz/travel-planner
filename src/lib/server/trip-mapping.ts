import { z } from "zod";
import { IsoDate } from "@/lib/domain/common";
import { StatedAge } from "@/lib/domain/group";
import { PurposeTags } from "@/lib/domain/plan";
import { oneOffLabel, oneOffTagsHash } from "@/lib/discover/one-off";
import { cachedParse } from "./group-mapping";
import {
  DEFAULT_RADIUS_KM,
  type Destination,
  type Trip,
  type TripGroupEntry,
  type TripInputParsed,
  type TripSummary,
  type TripTiming,
} from "@/lib/domain/trip";
import type { GeoPlace } from "@/lib/domain/geo";
import { accessOf, type ShareAccess } from "@/lib/domain/sharing";

/** snake_case row of public.trips (the columns the app reads and writes). */
export type TripRow = {
  id: string;
  owner_id: string;
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
  /** One-off group (spec group-text): free text, the user's corrected structure, and the Haiku parse cache. */
  group_text: string | null;
  group_structure: unknown;
  group_parsed: unknown;
  group_parsed_hash: string | null;
  purpose_id: string | null;
  /** One-off purpose (spec trip-purpose-text): free text and the server-written Haiku tags for it. */
  purpose_text: string | null;
  purpose_tags: unknown;
  purpose_tags_hash: string | null;
  wants_flights: boolean;
  origin_airports: string[];
  notes: string | null;
  destination_search_id: string | null;
  created_at: string;
  updated_at: string;
  /** Embedded `trip_shares(grantee_id, access)` (RLS: the viewer's own row, or every grant when the viewer owns the trip). */
  trip_shares?: { grantee_id: string; access: ShareAccess }[] | null;
};

export const TRIP_COLUMNS =
  "id, owner_id, title, dest_kind, dest_name, dest_place_name, dest_geo_id, dest_country_code, dest_admin1, dest_lat, dest_lon, dest_timezone, dest_radius_km, length_days, start_date, months, group_id, group_text, group_structure, group_parsed, group_parsed_hash, purpose_id, purpose_text, purpose_tags, purpose_tags_hash, wants_flights, origin_airports, notes, destination_search_id, created_at, updated_at";

/** TRIP_COLUMNS plus the share rows the viewer may see (their own, or all grants of their own trip). */
export const TRIP_COLUMNS_WITH_SHARES = `${TRIP_COLUMNS}, trip_shares(grantee_id, access)`;

/** The writable columns (everything except id, owner_id, the timestamps and the server-written parse cache). */
export type TripWrite = Omit<TripRow, "id" | "owner_id" | "created_at" | "updated_at" | "group_parsed" | "group_parsed_hash" | "purpose_tags" | "purpose_tags_hash" | "destination_search_id" | "trip_shares"> & {
  /** Omitted = not written (an update keeps the stored link; an insert gets null). */
  destination_search_id?: string | null;
};

const StoredStructure = z.array(
  z.object({
    count: z.number().int().min(1).max(50),
    label: z.string().optional(),
    notes: z.string().optional(),
    age: StatedAge.optional(),
    ageAsOf: IsoDate.optional(),
  }),
);

export function rowToGroupStructure(raw: unknown): TripGroupEntry[] {
  const parsed = StoredStructure.safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}


/** Tags of the one-off purpose, only while they were made for the current text (hash) and still parse. */
export function rowToPurposeTags(row: Pick<TripRow, "purpose_text" | "purpose_tags" | "purpose_tags_hash">): PurposeTags | undefined {
  if (!row.purpose_text || row.purpose_tags == null || row.purpose_tags_hash !== oneOffTagsHash(row.purpose_text)) return undefined;
  const parsed = PurposeTags.safeParse(row.purpose_tags);
  return parsed.success ? parsed.data : undefined;
}

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

/** The viewer's access to a trip row: owner, the level of their share row, else `read` (fails closed). */
export function tripAccess(row: Pick<TripRow, "owner_id" | "trip_shares">, viewerId: string): Trip["access"] {
  return accessOf(row.owner_id, viewerId, row.trip_shares?.find((s) => s.grantee_id === viewerId)?.access);
}

export function rowToTrip(row: TripRow, viewerId: string): Trip {
  return {
    id: row.id,
    ownerId: row.owner_id,
    access: tripAccess(row, viewerId),
    title: row.title ?? undefined,
    destination: rowToDestination(row),
    lengthDays: row.length_days,
    timing: rowToTiming(row),
    groupId: row.group_id,
    groupText: row.group_text ?? undefined,
    groupStructure: rowToGroupStructure(row.group_structure),
    groupParse: cachedParse(row.group_text, row.group_parsed, row.group_parsed_hash),
    purposeId: row.purpose_id,
    purposeText: row.purpose_text ?? undefined,
    purposeTags: rowToPurposeTags(row),
    wantsFlights: row.wants_flights,
    originAirports: row.origin_airports,
    notes: row.notes ?? undefined,
    destinationSearchId: row.destination_search_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type NamedRef = { name: string } | null;
export type TripSummaryRow = TripRow & {
  travel_groups: NamedRef;
  trip_purposes: NamedRef;
  /** Own trips list: `trip_shares(count)` for `shareCount`. */
  share_count?: { count: number }[] | null;
};

/** `sharedBy` is set for an incoming trip (listSharedWithMe); own trips pass null. */
export function rowToSummary(row: TripSummaryRow, viewerId: string, sharedBy: TripSummary["sharedBy"] = null): TripSummary {
  const trip = rowToTrip(row, viewerId);
  return {
    id: trip.id,
    title: trip.title,
    destination: trip.destination,
    lengthDays: trip.lengthDays,
    timing: trip.timing,
    updatedAt: trip.updatedAt,
    groupName: row.travel_groups?.name ?? (row.group_text ? row.group_text.slice(0, 40) : null),
    purposeName: row.trip_purposes?.name ?? (row.purpose_text ? oneOffLabel(row.purpose_text) : null),
    access: trip.access,
    sharedBy,
    shareCount: trip.access === "owner" ? (row.share_count?.[0]?.count ?? 0) : 0,
  };
}

/**
 * Builds the full write set. Geocoded fields come ONLY from `place` (the server-side
 * lookup), never from the client. `place` must be given for city/region and is ignored
 * for freetext. Always returns every column so an update also clears fields of the old kind.
 */
/** Uppercased ISO 3166-1 alpha-2, or null if invalid (the DB CHECK would otherwise fail generically). */
export function normalizeCountryCode(code: string | null | undefined): string | null {
  const c = code?.trim().toUpperCase();
  return c && /^[A-Z]{2}$/.test(c) ? c : null;
}

/**
 * Corrected structure of the one-off group as stored. A numeric age gets `ageAsOf` = today, unless the entry at the
 * same position kept the same stated age (then the old date stays, so the age keeps advancing from the statement).
 */
export function buildGroupStructure(
  entries: TripInputParsed["groupStructure"],
  existing: unknown,
  today: string,
): Record<string, unknown>[] {
  const before = rowToGroupStructure(existing);
  return entries.map((e, i) => {
    const numeric = e.age && e.age.ageMode !== "relativeToMe" ? e.age : undefined;
    const prev = before[i]?.age;
    const same = numeric && prev && prev.ageMode === numeric.ageMode && "age" in prev && prev.age === numeric.age;
    return {
      count: e.count,
      ...(e.label ? { label: e.label } : {}),
      ...(e.notes ? { notes: e.notes } : {}),
      ...(e.age ? { age: e.age } : {}),
      ...(numeric ? { ageAsOf: same && before[i]?.ageAsOf ? before[i].ageAsOf : today } : {}),
    };
  });
}

export function buildTripWrite(
  input: TripInputParsed,
  place: GeoPlace | null,
  opts: { today?: string; existing?: Pick<TripRow, "group_structure"> | null } = {},
): TripWrite {
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
  const countryCode = normalizeCountryCode(d.kind === "freetext" ? d.countryCode : place?.countryCode);
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
    // Mutually exclusive with group_id (also a DB check). Without text there is no structure.
    group_text: input.groupId ? null : (input.groupText ?? null),
    group_structure:
      input.groupId || !input.groupText || input.groupStructure.length === 0
        ? null
        : buildGroupStructure(input.groupStructure, opts.existing?.group_structure, opts.today ?? new Date().toISOString().slice(0, 10)),
    purpose_id: input.purposeId,
    // Mutually exclusive with purpose_id (also a DB check): a saved purpose always clears the text.
    purpose_text: input.purposeId ? null : (input.purposeText ?? null),
    wants_flights: input.wantsFlights,
    origin_airports: input.originAirports,
    notes: input.notes ?? null,
    ...(input.destinationSearchId !== undefined ? { destination_search_id: input.destinationSearchId } : {}),
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
    before.purpose_id !== after.purpose_id ||
    before.purpose_text !== after.purpose_text
  );
}
