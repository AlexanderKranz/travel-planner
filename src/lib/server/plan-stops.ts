import "server-only";
import { berlinToday } from "@/lib/date";
import type { FactsCtx, StopFacts } from "@/lib/domain/facts";
import type { Locale } from "@/lib/domain/profile";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import type { CuisineWish } from "@/lib/facts/cuisine";
import type { PlanInputStored } from "@/lib/plan/input";
import type { StopPoints } from "@/lib/plan/stops-input";
import { extendInputWithStops, resolvedFromInput, stopPointsOf, stopRows, stopsToGeocode, stopsToRetry, stopsWithoutSights } from "@/lib/plan/stops-input";
import { jobsForStops } from "@/lib/places-retry";
import { enqueuePlaceRetries } from "./place-retries";
import { getStopFacts, lookupStops, resolveStopPlaces, stopDriveTimes } from "./facts/stops";
import { resolveTripStops, type DeriveStopsFromNotes } from "./trip-stops";

/** The upgrade of an old input and the retry of failed stops share this much time, cache and Geoapify only (port-places [P8]). */
export const STOP_PREP_MAX_MS = 30_000;
/** Stops whose failed geocoding is tried again per patch (each is one cached Open-Meteo search, up to 3 languages). */
export const MAX_GEOCODE_RETRIES = 3;
/** Time that stays for the existing needPlaces deadline (60 s places + second call) of an iterate request. */
export const STOP_PREP_RESERVE_MS = 240_000;

/** Time for the stop preparation of a patch: min(30 s, left - 240 s); zero or less = skip it. */
export const stopPrepBudget = (leftMs: number): number => Math.min(STOP_PREP_MAX_MS, leftMs - STOP_PREP_RESERVE_MS);

export type StopPrep = {
  stored: PlanInputStored;
  /** The base input had no `trip.stops` and now has (it was made before plan-8). */
  upgraded: boolean;
  /** Stops looked up again because an earlier lookup failed. */
  retried: number;
  /** Whether the trip has stops at all (confirmed or derived). */
  tripHasStops: boolean;
};

/**
 * Before the first patch call (port-places section 4):
 * 1. a base input without `trip.stops` of a trip that has stops gets them: geocode, look up (cache and Geoapify only),
 *    add `trip.stops` and `stopPlaces`;
 * 2. stops in scope whose lookup failed are looked up again (they may be cached by now), and so are stops in scope
 *    whose entry lists no sights (an input from before sights were always looked up per stop, `stopsWithoutSights`).
 * Both share `budgetMs`. Failures are queued for the retry worker. Never throws: on any problem the input stays as it was.
 */
export async function prepareStopsForPatch(a: {
  trip: Trip;
  purpose: TripPurpose | null;
  input: PlanInputStored;
  scopeDays: readonly number[];
  locale: Locale;
  userId: string;
  /** How notes-derived stops are read; the pipeline passes `notesDeriver(session)`. */
  derive?: DeriveStopsFromNotes;
  budgetMs: number;
}): Promise<StopPrep> {
  const base: StopPrep = { stored: a.input, upgraded: false, retried: 0, tripHasStops: !!a.input.llm.trip?.stops?.length };
  const started = Date.now();
  try {
    const ctx: FactsCtx = { userId: a.userId, locale: a.locale, today: berlinToday() };
    const country = a.trip.destination.kind === "freetext" ? null : a.trip.destination.countryCode;
    const cuisine = a.input.llm.restaurants?.ask as CuisineWish | undefined;
    const left = () => Math.max(0, a.budgetMs - (Date.now() - started));
    let stored = a.input;
    let upgraded = false;
    let tripHasStops = !!stored.llm.trip?.stops?.length;

    if (!tripHasStops) {
      const stops = await resolveTripStops(a.trip, a.derive);
      tripHasStops = stops.length > 0;
      if (stops.length && a.budgetMs > 0) {
        const facts = await getStopFacts(a.trip, stops, a.purpose, ctx, { budgetMs: left(), overpass: "cache_only" });
        if (facts.length) {
          const resolved = facts.map((f) => f.stop);
          const drive = await stopDriveTimes(facts, ctx);
          stored = extendInputWithStops(stored, { rows: stopRows(stops, resolved), points: stopPointsOf(resolved), facts, lang: a.locale, cuisine, countryCode: country, drive });
          upgraded = true;
          await enqueuePlaceRetries(jobsForStops(facts));
        }
      }
    }

    let retried = 0;
    if (!upgraded && a.budgetMs > 0) {
      // A stop whose geocoding failed has no point, so the retry below would never see it: geocode it again first.
      const points: StopPoints = {};
      for (const g of stopsToGeocode(stored, a.scopeDays).slice(0, MAX_GEOCODE_RETRIES)) {
        if (left() <= 0) break;
        const [r] = await resolveStopPlaces(a.trip, [{ day: g.day, place: g.place }], ctx);
        if (r?.role === "stop" && r.status === "ok" && r.point) points[g.id] = { ...r.point };
      }
      if (Object.keys(points).length) stored = { ...stored, stopPoints: { ...stored.stopPoints, ...points } };
      const ids = [...new Set([...stopsToRetry(stored, a.scopeDays), ...stopsWithoutSights(stored, a.scopeDays)])];
      if (ids.length) {
        const resolved = resolvedFromInput(stored).filter((r) => ids.includes(r.id));
        const wantsCafes = a.purpose?.tags?.cafes === true || (stored.llm.stopPlaces ?? []).some((p) => ids.includes(p.id) && p.cafes);
        const facts: StopFacts[] = await lookupStops(resolved, a.purpose, ctx, { budgetMs: left(), overpass: "cache_only", cafes: wantsCafes });
        const drive = await stopDriveTimes(facts, ctx);
        stored = extendInputWithStops(stored, { facts, lang: a.locale, cuisine, countryCode: country, drive });
        retried = facts.length;
        await enqueuePlaceRetries(jobsForStops(facts));
      }
    }
    return { stored, upgraded, retried, tripHasStops };
  } catch {
    return base;
  }
}
