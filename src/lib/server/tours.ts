"use server";

import { z } from "zod";
import type { InterestOrGeneral } from "@/lib/domain/facts";
import type { Locale } from "@/lib/domain/profile";
import { fail, zodIssues, type ActionError, type ActionResult } from "@/lib/domain/result";
import {
  MAX_TOURS_PER_USER,
  TourDraft,
  type Tour,
  type TourDraftParsed,
  type TourInput,
  type TourSuggestion,
  type TourSummary,
} from "@/lib/domain/tour";
import { interestsForTrip } from "@/lib/facts/interest-sources";
import { getPlaceById } from "@/lib/integrations/open-meteo-geocoding";
import { ownTitle } from "@/lib/tour/title";
import { logEvent } from "./events";
import { getPurpose } from "./purposes";
import { externalWriteAllowed, rateLimit } from "./rate-limit";
import { getUserSession } from "./session";
import { rowToTour, TOUR_COLUMNS, tourToSummary, type TourRow } from "./tour/mapping";
import { cityDestination, cityPlaces } from "./tour/places";
import { signPointRef } from "./tour/point-ref";
import { GEO_KEY, knownPoints, resolveDraft } from "./tour/resolve";

/**
 * City tours (docs/specs/city-tour.md, ADR 0012): create, update, delete, list, read, link to a trip day, and the
 * place suggestions of the form. Computing lives in `./tour/compute.ts`. RLS does the access control (owner; trip
 * grantees read linked tours); the actions check access first to give clear errors. `result`, `result_hash` and
 * `computed_at` are never written here (no user grant; compute writes them with the secret key).
 */

const Id = z.string().uuid();
const FK_VIOLATION = "23503"; // trip link to a trip of another owner (composite FK) or a deleted trip
const Day = z.number().int().min(1).max(60);

type Session = NonNullable<Awaited<ReturnType<typeof getUserSession>>>;

async function profileLocale(session: Session): Promise<Locale> {
  const { data } = await session.supabase.from("profiles").select("locale").eq("id", session.userId).maybeSingle();
  return data?.locale === "en" ? "en" : "de";
}

async function readTour(session: Session, id: string): Promise<{ ok: true; row: TourRow } | { ok: false; error: ActionError }> {
  const { data, error } = await session.supabase.from("city_tours").select(TOUR_COLUMNS).eq("id", id).maybeSingle<TourRow>();
  if (error) return { ok: false, error: "failed" };
  if (!data) return { ok: false, error: "not_found" };
  return { ok: true, row: data };
}

/** The trip a tour is linked to must be the user's own and the day within its length (spec 9.1, 9.3). */
async function checkTripLink(session: Session, tripId: string, day: number | null): Promise<ActionError | null> {
  const { data, error } = await session.supabase
    .from("trips")
    .select("id, owner_id, length_days")
    .eq("id", tripId)
    .maybeSingle<{ id: string; owner_id: string; length_days: number }>();
  if (error) return "failed";
  if (!data) return "not_found";
  if (data.owner_id !== session.userId) return "forbidden";
  if (day !== null && day > data.length_days) return "invalid";
  return null;
}

const eventProps = (i: TourInput) => ({
  places: i.places.length,
  mode: i.mode,
  route: i.route,
  order: i.order,
  hasCity: i.city !== undefined,
  hasStart: i.start !== undefined,
  hasTime: i.startTime !== undefined,
});

type Resolve = { ok: true; input: TourInput } | { ok: false; result: ReturnType<typeof fail> };

/** Draft (already parsed) → validated input with server-resolved points. `stored`: the tour before the update. */
async function resolve(session: Session, draft: TourDraftParsed, stored: Tour | null): Promise<Resolve> {
  const locale = await profileLocale(session);
  const known = knownPoints(stored?.input ?? null, stored?.result ?? null);
  const r = await resolveDraft(draft, known, locale, { userId: session.userId });
  if (r.ok) return { ok: true, input: r.input };
  if (r.error === "unknown_point") return { ok: false, result: fail("unknown_point", r.keys.map((k) => ({ path: k, message: "unknown point" }))) };
  if (r.error === "invalid") return { ok: false, result: fail("invalid", r.issues) };
  return { ok: false, result: fail("failed") };
}

const toResult = (row: TourRow, userId: string): ActionResult<Tour> => {
  const tour = rowToTour(row, userId);
  return tour ? { ok: true, data: tour } : fail("failed");
};

/**
 * New tour from a draft (points as keys + signed references, spec 3.1). Optional link to a day of an own trip.
 * Errors: unauthenticated, invalid (issues), rate_limited, limit_reached (50 tours), unknown_point (issues name the
 * keys), not_found / forbidden (trip), failed.
 */
export async function createTour(draft: TourDraft, link?: { tripId: string; day?: number | null }): Promise<ActionResult<Tour>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const parsed = TourDraft.safeParse(draft);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  if (link && (!Id.safeParse(link.tripId).success || (link.day != null && !Day.safeParse(link.day).success))) {
    return fail("invalid");
  }
  if (!externalWriteAllowed(session.userId)) return fail("rate_limited");

  const { count, error: countError } = await session.supabase
    .from("city_tours")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", session.userId); // tours visible through shared trips do not count
  if (countError) return fail("failed");
  if ((count ?? 0) >= MAX_TOURS_PER_USER) return fail("limit_reached");
  if (link) {
    const linkError = await checkTripLink(session, link.tripId, link.day ?? null);
    if (linkError) return fail(linkError);
  }

  const r = await resolve(session, parsed.data, null);
  if (!r.ok) return r.result;
  // owner_id comes from its column default (auth.uid()); result columns have no user grant.
  const { data, error } = await session.supabase
    .from("city_tours")
    .insert({
      title: ownTitle(r.input),
      input: r.input,
      trip_id: link?.tripId ?? null,
      trip_day: link ? (link.day ?? null) : null,
    })
    .select(TOUR_COLUMNS)
    .single<TourRow>();
  if (error) return fail(error.code === FK_VIOLATION ? "not_found" : "failed");
  await logEvent({ event: "tour.created", userId: session.userId, props: { ...eventProps(r.input), linked: link !== undefined } });
  return toResult(data, session.userId);
}

/**
 * Saves a new title and input (owner only; grantees read). Points already in the tour may come back without a
 * reference. `expectedUpdatedAt`: the `updatedAt` the form was loaded with; a different stored value → `conflict`.
 * The stored result stays until the next computation; `outdated` tells whether it still matches.
 */
export async function updateTour(id: string, draft: TourDraft, expectedUpdatedAt?: string): Promise<ActionResult<Tour>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const parsed = TourDraft.safeParse(draft);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  if (!externalWriteAllowed(session.userId)) return fail("rate_limited");

  const before = await readTour(session, id);
  if (!before.ok) return fail(before.error);
  if (before.row.owner_id !== session.userId) return fail("forbidden");
  if (expectedUpdatedAt !== undefined && before.row.updated_at !== expectedUpdatedAt) return fail("conflict");
  const r = await resolve(session, parsed.data, rowToTour(before.row, session.userId));
  if (!r.ok) return r.result;
  const { data, error } = await session.supabase
    .from("city_tours")
    .update({ title: ownTitle(r.input), input: r.input })
    .eq("id", id)
    .eq("owner_id", session.userId)
    .select(TOUR_COLUMNS)
    .maybeSingle<TourRow>();
  if (error) return fail("failed");
  if (!data) return fail("not_found");
  return toResult(data, session.userId);
}

/** Owner only. Errors: unauthenticated, invalid, not_found, forbidden (a grantee), failed. */
export async function deleteTour(id: string): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const before = await readTour(session, id);
  if (!before.ok) return fail(before.error);
  if (before.row.owner_id !== session.userId) return fail("forbidden");
  const { data, error } = await session.supabase
    .from("city_tours")
    .delete()
    .eq("id", id)
    .eq("owner_id", session.userId)
    .select("id");
  if (error) return fail("failed");
  if (!data?.length) return fail("not_found");
  return { ok: true };
}

/** The user's own tours, newest change first (tours of trips shared with the user: `listTripTours`). */
export async function listTours(): Promise<ActionResult<TourSummary[]>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const { data, error } = await session.supabase
    .from("city_tours")
    .select(TOUR_COLUMNS)
    .eq("owner_id", session.userId)
    .order("updated_at", { ascending: false })
    .returns<TourRow[]>();
  if (error) return fail("failed");
  return { ok: true, data: rowsToSummaries(data, session.userId) };
}

/** Tours linked to a trip the user can read (own or shared; grantees get `access: "read"`), by day then start time. */
export async function listTripTours(tripId: string): Promise<ActionResult<TourSummary[]>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(tripId).success) return fail("invalid");
  const { data, error } = await session.supabase
    .from("city_tours")
    .select(TOUR_COLUMNS)
    .eq("trip_id", tripId)
    .order("trip_day", { ascending: true, nullsFirst: false })
    .returns<TourRow[]>();
  if (error) return fail("failed");
  const list = rowsToSummaries(data, session.userId);
  return {
    ok: true,
    data: list.sort((a, b) => (a.tripDay ?? 99) - (b.tripDay ?? 99) || (a.startTime ?? "99").localeCompare(b.startTime ?? "99")),
  };
}

function rowsToSummaries(rows: TourRow[], userId: string): TourSummary[] {
  return rows.flatMap((row) => {
    const t = rowToTour(row, userId);
    return t ? [tourToSummary(t)] : [];
  });
}

/** One tour; `access` is "read" for a grantee of the linked trip. */
export async function getTour(id: string): Promise<ActionResult<Tour>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const r = await readTour(session, id);
  if (!r.ok) return fail(r.error);
  return toResult(r.row, session.userId);
}

/**
 * Links a tour to a day of an own trip, or unlinks it (`tripId` null). `day` null = linked without a day. Owner
 * only; the composite FK also refuses a trip of another owner (23503 → not_found). A day beyond the trip's length
 * is `invalid` here (it can only arise later, when the trip is shortened).
 */
export async function linkTourToTrip(tourId: string, tripId: string | null, day: number | null): Promise<ActionResult<Tour>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(tourId).success) return fail("invalid");
  if (tripId !== null && !Id.safeParse(tripId).success) return fail("invalid");
  if (day !== null && (tripId === null || !Day.safeParse(day).success)) return fail("invalid");
  if (!externalWriteAllowed(session.userId)) return fail("rate_limited");

  const before = await readTour(session, tourId);
  if (!before.ok) return fail(before.error);
  if (before.row.owner_id !== session.userId) return fail("forbidden");
  if (tripId) {
    const linkError = await checkTripLink(session, tripId, day);
    if (linkError) return fail(linkError);
  }
  const { data, error } = await session.supabase
    .from("city_tours")
    .update({ trip_id: tripId, trip_day: day })
    .eq("id", tourId)
    .eq("owner_id", session.userId)
    .select(TOUR_COLUMNS)
    .maybeSingle<TourRow>();
  if (error) return fail(error.code === FK_VIOLATION ? "not_found" : "failed");
  if (!data) return fail("not_found");
  await logEvent({ event: "tour.linked", userId: session.userId, props: { linked: tripId !== null, hasDay: day !== null } });
  return toResult(data, session.userId);
}

export type TourSuggestions = { suggestions: TourSuggestion[]; pending: boolean; fetchedAt: string | null };

const SuggestArgs = z.object({ city: z.string().regex(GEO_KEY), tripId: z.string().uuid().optional() });

/**
 * Verified places in the city for the form (spec 3.1 source 1): the cached OSM places around the city (plus the
 * linked trip's purpose interests), each with a signed reference for createTour / updateTour. 0 external calls when
 * cached; else at most the Geoapify fast path, and missing lookups are queued for the retry job (`pending`).
 * `city`: the `geo:<GeoNames id>` key of the city. Errors: unauthenticated, invalid, rate_limited, not_found (city
 * or trip), failed.
 */
export async function tourSuggestions(args: { city: string; tripId?: string }): Promise<ActionResult<TourSuggestions>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const parsed = SuggestArgs.safeParse(args);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  if (!rateLimit(`tour-suggest:${session.userId}`, 30, 60_000).ok) return fail("rate_limited");
  const locale = await profileLocale(session);

  let place;
  try {
    place = await getPlaceById(Number(GEO_KEY.exec(parsed.data.city)![1]), locale);
  } catch {
    return fail("failed");
  }
  if (!place) return fail("not_found");

  const interests: InterestOrGeneral[] = ["general"];
  if (parsed.data.tripId) {
    const { data: trip, error } = await session.supabase
      .from("trips")
      .select("purpose_id")
      .eq("id", parsed.data.tripId)
      .maybeSingle<{ purpose_id: string | null }>();
    if (error) return fail("failed");
    if (!trip) return fail("not_found");
    if (trip.purpose_id) {
      const purpose = await getPurpose(trip.purpose_id);
      if (purpose.ok) interests.push(...interestsForTrip(purpose.data.guided, purpose.data.tags).keys);
    }
  }

  const found = await cityPlaces(cityDestination(place), [...new Set(interests)], {
    userId: session.userId,
    locale,
    network: true,
  });
  try {
    const suggestions = found.places.map((p) => {
      const point = { key: p.key, name: p.name, lat: p.lat, lon: p.lon, source: "osm" as const, cat: p.cat };
      return { ...point, ref: signPointRef(point) };
    });
    return { ok: true, data: { suggestions, pending: found.pending, fetchedAt: found.fetchedAt } };
  } catch {
    return fail("failed");
  }
}
