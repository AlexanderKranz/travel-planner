"use server";

import { z } from "zod";
import type { GeoPlace } from "@/lib/domain/geo";
import type { Locale } from "@/lib/domain/profile";
import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
import {
  MAX_TRIPS_PER_USER,
  TripInput,
  type Trip,
  type TripInputParsed,
  type TripSummary,
} from "@/lib/domain/trip";
import { isKnownIata } from "@/lib/integrations/airports";
import { getPlaceById } from "@/lib/integrations/open-meteo-geocoding";
import { logEvent } from "./events";
import { ensureGroupParse } from "./group-text";
import { getUserSession } from "./session";
import { scheduleTripWarm } from "./warm";
import {
  buildTripWrite,
  factsInputsChanged,
  rowToSummary,
  rowToTrip,
  TRIP_COLUMNS,
  type TripRow,
  type TripSummaryRow,
  type TripWrite,
} from "./trip-mapping";

const Id = z.string().uuid();
const FK_VIOLATION = "23503"; // groupId/purposeId of another user (or unknown) fails the composite FK

type Session = NonNullable<Awaited<ReturnType<typeof getUserSession>>>;

async function profileLocale(session: Session): Promise<Locale> {
  const { data } = await session.supabase.from("profiles").select("locale").eq("id", session.userId).maybeSingle();
  return data?.locale === "en" ? "en" : "de";
}

type PlaceResult = { ok: true; place: GeoPlace | null } | { ok: false; error: "unknown_place" | "failed" };

/** Server-side geocoding lookup by id. Stored coordinates never come from the client. */
async function resolvePlace(
  input: TripInputParsed,
  locale: Locale,
  reuse: TripRow | null,
): Promise<PlaceResult> {
  const d = input.destination;
  if (d.kind === "freetext") return { ok: true, place: null };
  if (reuse && reuse.dest_geo_id === d.geoId && reuse.dest_lat !== null && reuse.dest_lon !== null && reuse.dest_place_name) {
    // Unchanged anchor place: reuse what an earlier server lookup stored (no upstream call).
    return {
      ok: true,
      place: {
        geoId: d.geoId,
        name: reuse.dest_place_name,
        featureCode: "",
        countryCode: reuse.dest_country_code,
        admin1: reuse.dest_admin1,
        lat: reuse.dest_lat,
        lon: reuse.dest_lon,
        timezone: reuse.dest_timezone,
        population: null,
        suggestedKind: d.kind,
      },
    };
  }
  try {
    const place = await getPlaceById(d.geoId, locale);
    return place ? { ok: true, place } : { ok: false, error: "unknown_place" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

function eventProps(trip: Trip) {
  return {
    tripId: trip.id,
    destKind: trip.destination.kind,
    timingKind: trip.timing.kind,
    lengthDays: trip.lengthDays,
    hasGroup: trip.groupId !== null,
    hasGroupText: trip.groupText !== undefined,
    hasPurpose: trip.purposeId !== null,
  };
}

/** One-off group text without a parse for the current text: ask Haiku once (best effort), then reload the row. */
async function withGroupParse(session: Session, trip: Trip): Promise<Trip> {
  if (!trip.groupText || trip.groupParse) return trip;
  const saved = await ensureGroupParse(session, { table: "trips", id: trip.id }, trip.groupText, false);
  if (!saved) return trip;
  const { data } = await session.supabase.from("trips").select(TRIP_COLUMNS).eq("id", trip.id).maybeSingle<TripRow>();
  return data ? rowToTrip(data) : trip;
}

export async function listTrips(): Promise<ActionResult<TripSummary[]>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const { data, error } = await session.supabase
    .from("trips")
    .select(`${TRIP_COLUMNS}, travel_groups(name), trip_purposes(name)`)
    .order("updated_at", { ascending: false })
    .returns<TripSummaryRow[]>();
  if (error) return fail("failed");
  return { ok: true, data: data.map(rowToSummary) };
}

export async function getTrip(id: string): Promise<ActionResult<Trip>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const { data, error } = await session.supabase
    .from("trips")
    .select(TRIP_COLUMNS)
    .eq("id", id)
    .maybeSingle<TripRow>();
  if (error) return fail("failed");
  if (!data) return fail("not_found");
  return { ok: true, data: rowToTrip(data) };
}

async function validate(input: TripInput) {
  const parsed = TripInput.safeParse(input);
  if (!parsed.success) return { ok: false, result: fail("invalid", zodIssues(parsed.error)) } as const;
  if (parsed.data.originAirports.some((code) => !isKnownIata(code))) {
    return { ok: false, result: fail("unknown_airport") } as const;
  }
  return { ok: true, data: parsed.data } as const;
}

export async function createTrip(input: TripInput): Promise<ActionResult<Trip>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const v = await validate(input);
  if (!v.ok) return v.result;

  // Business rule (D8): at most MAX_TRIPS_PER_USER trips per user.
  const { count, error: countError } = await session.supabase
    .from("trips")
    .select("id", { count: "exact", head: true });
  if (countError) return fail("failed");
  if ((count ?? 0) >= MAX_TRIPS_PER_USER) return fail("limit_reached");

  const locale = await profileLocale(session);
  const place = await resolvePlace(v.data, locale, null);
  if (!place.ok) return fail(place.error);

  // owner_id is filled by its column default (auth.uid()); RLS checks it.
  const { data, error } = await session.supabase
    .from("trips")
    .insert(buildTripWrite(v.data, place.place))
    .select(TRIP_COLUMNS)
    .single<TripRow>();
  if (error) return fail(error.code === FK_VIOLATION ? "not_found" : "failed");

  const trip = await withGroupParse(session, rowToTrip(data));
  await logEvent({ event: "trip.created", userId: session.userId, props: eventProps(trip) });
  await scheduleTripWarm(session, trip, locale);
  return { ok: true, data: trip };
}

export async function updateTrip(id: string, input: TripInput): Promise<ActionResult<Trip>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const v = await validate(input);
  if (!v.ok) return v.result;

  const { data: before, error: readError } = await session.supabase
    .from("trips")
    .select(TRIP_COLUMNS)
    .eq("id", id)
    .maybeSingle<TripRow>();
  if (readError) return fail("failed");
  if (!before) return fail("not_found");

  const locale = await profileLocale(session);
  const place = await resolvePlace(v.data, locale, before);
  if (!place.ok) return fail(place.error);

  const write: TripWrite = buildTripWrite(v.data, place.place, { existing: before });
  const { data, error } = await session.supabase
    .from("trips")
    .update(write)
    .eq("id", id)
    .select(TRIP_COLUMNS)
    .maybeSingle<TripRow>();
  if (error) return fail(error.code === FK_VIOLATION ? "not_found" : "failed");
  if (!data) return fail("not_found");

  const trip = await withGroupParse(session, rowToTrip(data));
  await logEvent({ event: "trip.updated", userId: session.userId, props: eventProps(trip) });
  if (factsInputsChanged(before, write)) await scheduleTripWarm(session, trip, locale);
  return { ok: true, data: trip };
}

export async function deleteTrip(id: string): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const { data, error } = await session.supabase.from("trips").delete().eq("id", id).select("id");
  if (error) return fail("failed");
  if (data.length === 0) return fail("not_found");
  await logEvent({ event: "trip.deleted", userId: session.userId, props: { tripId: id } });
  return { ok: true };
}
