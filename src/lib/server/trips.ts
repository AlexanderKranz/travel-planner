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
import { externalWriteAllowed } from "./rate-limit";
import { getUserSession } from "./session";
import { scheduleTripWarm } from "./warm";
import {
  buildTripWrite,
  factsInputsChanged,
  rowToSummary,
  rowToTrip,
  tripAccess,
  TRIP_COLUMNS,
  TRIP_COLUMNS_WITH_SHARES,
  type TripRow,
  type TripSummaryRow,
  type TripWrite,
} from "./trip-mapping";

const Id = z.string().uuid();
const FK_VIOLATION = "23503"; // groupId of another user (composite FK) or a purpose that is not usable (trigger)
const INSUFFICIENT_PRIVILEGE = "42501"; // owner-only columns (trigger trips_owner_only) or a policy refusal

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
  // The parse is stored on the trip row, so it is saved with the OWNER's id; the AI call is charged to the actor.
  const saved = await ensureGroupParse(session, { table: "trips", id: trip.id, ownerId: trip.ownerId }, trip.groupText, false);
  if (!saved) return trip;
  const { data } = await session.supabase.from("trips").select(TRIP_COLUMNS_WITH_SHARES).eq("id", trip.id).maybeSingle<TripRow>();
  return data ? rowToTrip(data, session.userId) : trip;
}

export async function listTrips(): Promise<ActionResult<TripSummary[]>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const { data, error } = await session.supabase
    .from("trips")
    // RLS also returns trips shared with the user: this list means "mine", so it filters by owner (spec sharing 3.5).
    // Shared trips come from listSharedWithMe.
    .select(`${TRIP_COLUMNS}, travel_groups(name), trip_purposes(name), share_count:trip_shares(count)`)
    .eq("owner_id", session.userId)
    .order("updated_at", { ascending: false })
    .returns<TripSummaryRow[]>();
  if (error) return fail("failed");
  return { ok: true, data: data.map((row) => rowToSummary(row, session.userId)) };
}

export async function getTrip(id: string): Promise<ActionResult<Trip>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const { data, error } = await session.supabase
    .from("trips")
    .select(TRIP_COLUMNS_WITH_SHARES)
    .eq("id", id)
    .maybeSingle<TripRow>();
  if (error) return fail("failed");
  if (!data) return fail("not_found");
  return { ok: true, data: rowToTrip(data, session.userId) };
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
  if (!externalWriteAllowed(session.userId)) return fail("rate_limited");

  // Business rule (D8): at most MAX_TRIPS_PER_USER trips per user.
  // Own trips only: trips shared with the user do not count (RLS would also return those).
  const { count, error: countError } = await session.supabase
    .from("trips")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", session.userId);
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

  const trip = await withGroupParse(session, rowToTrip(data, session.userId));
  await logEvent({ event: "trip.created", userId: session.userId, props: eventProps(trip) });
  await scheduleTripWarm(session, trip, locale);
  return { ok: true, data: trip };
}

/**
 * `expectedUpdatedAt`: the `updatedAt` the form was loaded with. A different stored value means someone else changed the
 * trip meanwhile: `conflict` (spec sharing 3.6). Omitted = no check (callers that never held a form).
 * A write grantee keeps the group and the purpose as stored (owner-only columns, trigger `trips_owner_only`).
 */
export async function updateTrip(id: string, input: TripInput, expectedUpdatedAt?: string): Promise<ActionResult<Trip>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const v = await validate(input);
  if (!v.ok) return v.result;
  if (!externalWriteAllowed(session.userId)) return fail("rate_limited");

  const { data: before, error: readError } = await session.supabase
    .from("trips")
    .select(TRIP_COLUMNS_WITH_SHARES)
    .eq("id", id)
    .maybeSingle<TripRow>();
  if (readError) return fail("failed");
  if (!before) return fail("not_found");
  const access = tripAccess(before, session.userId);
  if (access === "read") return fail("forbidden");
  if (expectedUpdatedAt !== undefined && before.updated_at !== expectedUpdatedAt) return fail("conflict");

  const locale = await profileLocale(session);
  const place = await resolvePlace(v.data, locale, before);
  if (!place.ok) return fail(place.error);

  const built: TripWrite = buildTripWrite(v.data, place.place, { existing: before });
  // Non-owner: group and purpose stay as stored whatever the form says (the trigger would reject a change).
  const write: TripWrite =
    access === "owner"
      ? built
      : {
          ...built,
          group_id: before.group_id,
          group_text: before.group_text,
          group_structure: before.group_structure,
          purpose_id: before.purpose_id,
        };
  let query = session.supabase.from("trips").update(write).eq("id", id);
  // Optimistic check: the write only lands while nobody changed the row since it was read.
  if (expectedUpdatedAt !== undefined) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select(TRIP_COLUMNS_WITH_SHARES).maybeSingle<TripRow>();
  if (error) {
    if (error.code === INSUFFICIENT_PRIVILEGE) return fail("forbidden");
    return fail(error.code === FK_VIOLATION ? "not_found" : "failed");
  }
  // The row was readable a moment ago: no row back means somebody changed it in between.
  if (!data) return fail(expectedUpdatedAt !== undefined ? "conflict" : "not_found");

  const trip = await withGroupParse(session, rowToTrip(data, session.userId));
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
