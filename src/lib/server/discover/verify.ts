import "server-only";
import { MAX_CARDS_PER_ROUND, type DropCounts, type DropReason, type SuggestionCard } from "@/lib/domain/destination-search";
import type { MonthlyClimate, PlaceCandidate } from "@/lib/domain/facts";
import type { FactsCtx } from "@/lib/domain/facts";
import type { GeoPlace } from "@/lib/domain/geo";
import type { InterestKey } from "@/lib/domain/interests";
import { DEFAULT_RADIUS_KM } from "@/lib/domain/trip";
import { climateMean, passesAllClimate } from "@/lib/discover/climate-rules";
import { assessDrive } from "@/lib/discover/drive";
import { assessFlight } from "@/lib/discover/flight";
import { isDuplicate, kindOf, pickAnchorPlace } from "@/lib/discover/names";
import { cleanReason } from "@/lib/discover/reason";
import { selectSearchInterests, VERIFIABILITY } from "@/lib/discover/verifiability";
import { driveMaxMin } from "@/lib/drive/estimate";
import { CLIMATE_PERIOD } from "@/lib/facts/climate";
import type { DriveRoute } from "@/lib/integrations/openrouteservice";
import { getPlaceById, searchPlacesCached } from "@/lib/integrations/open-meteo-geocoding";
import type { CachedResult } from "../api-cache";
import type { Idea } from "../ai/destination-ideas";
import { getDriveRoute } from "../facts/drive-route";
import { getClimateAt } from "../facts/weather";
import { getPlacesAt } from "../facts/places";

/** Time for steps 3 and 4 of one search; ideas not reached are not shown (spec section 5). */
export const VERIFY_BUDGET_MS = 45_000;
/** Cold climate lookups per search: Open-Meteo's per-minute limit (spec [D9]). */
export const MAX_CLIMATE_MISSES = 5;
export const VERIFY_CONCURRENCY = 2;
/** Drive mode: this many failed lookups in a row stop the search, even after an earlier success (each costs up to 20 s). */
export const DRIVE_MAX_CONSECUTIVE_FAILURES = 3;

/** The external lookups, injectable for tests. Every default goes through `cached()` and so reaches `api_calls`. */
export type VerifyDeps = {
  geocode: (anchor: string, lang: "de" | "en", userId: string) => Promise<CachedResult<GeoPlace[]>>;
  climate: (point: { lat: number; lon: number }, ctx: FactsCtx, fetchAllowed: () => boolean) => Promise<CachedResult<MonthlyClimate[]>>;
  pois: (
    interest: InterestKey,
    point: { lat: number; lon: number },
    baseRadiusKm: number,
    ctx: FactsCtx,
    networkAllowed: boolean,
  ) => Promise<{ radiusKm: number; result: CachedResult<PlaceCandidate[]> } | null>;
  /** One ferry-free road route from the start to a place (cached per place pair). A failure is `ok: false`, never "no road". */
  driveRoute: (
    origin: { lat: number; lon: number },
    place: { geoId: number; lat: number; lon: number },
    ctx: FactsCtx,
  ) => Promise<CachedResult<DriveRoute>>;
  /** A place by id in the user's language (cached 365 days); null on any failure, the English name is used then. */
  placeById: (geoId: number, lang: "de" | "en") => Promise<GeoPlace | null>;
  now: () => number;
};

export const defaultVerifyDeps: VerifyDeps = {
  geocode: (anchor, lang, userId) => searchPlacesCached(anchor, lang, { userId }),
  climate: (point, ctx, fetchAllowed) => getClimateAt(point, ctx, { fetchAllowed }),
  pois: (interest, point, baseRadiusKm, ctx, networkAllowed) => getPlacesAt(interest, point, baseRadiusKm, ctx, { networkAllowed }),
  driveRoute: (origin, place, ctx) => getDriveRoute(origin, place, ctx),
  placeById: async (geoId, lang) => {
    try {
      return await getPlaceById(geoId, lang);
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
};

type Anchor =
  | { status: "ok"; place: GeoPlace; fetchedAt: string; stale: boolean }
  | { status: "not_found" }
  | { status: "failed" };

/**
 * Step 1 for one idea. The model writes `anchor` as the English GeoNames spelling, and the geocoder only matches names
 * in the requested language, so the search runs with lang=en first and, on a miss, once more in German (local
 * spellings such as "Köln"). A hit in another language than the user's is read again by id for the localized name
 * (cached). At most 3 calls per idea, all through `cached()`. A failed call is a failure, never "not found".
 */
export async function resolveAnchor(idea: Idea, lang: "de" | "en", userId: string, deps: VerifyDeps): Promise<Anchor> {
  for (const searchLang of ["en", "de"] as const) {
    const res = await deps.geocode(idea.anchor, searchLang, userId);
    if (!res.ok) return { status: "failed" };
    const hit = pickAnchorPlace(res.data, idea.anchor, idea.cc);
    if (!hit) continue;
    let place = hit;
    if (searchLang !== lang) {
      const local = await deps.placeById(hit.geoId, lang);
      if (local) place = { ...hit, name: local.name, admin1: local.admin1 ?? hit.admin1 };
    }
    return { status: "ok", place, fetchedAt: res.fetchedAt, stale: res.stale };
  }
  return { status: "not_found" };
}

export type VerifyInput = {
  ideas: Idea[];
  round: 1 | 2;
  lang: "de" | "en";
  userId: string;
  today: string;
  /** Selected months; empty = no climate check. */
  months: number[];
  /** Origin airports (at most 2); empty = no estimate and no radius. */
  origins: string[];
  /** Active flight limit in hours; null = no radius filter. Null in drive mode. */
  maxHours: number | null;
  /** Drive mode: the start and the limit. Absent = flight mode. Every card then carries a verified drive (D10). */
  drive?: { home: { lat: number; lon: number }; maxHours: number };
  /** All interest keys of the purpose; at most 2 are searched. */
  interests: InterestKey[];
  /** Cards of an earlier round: their places are not proposed again. */
  existing: Pick<SuggestionCard, "geoId">[];
};

export type VerifyOutcome = {
  cards: SuggestionCard[];
  drops: DropCounts;
  /** Reasons removed because they stated a banned fact (the card stays). */
  reasonsRemoved: number;
  /** Every geocoding lookup failed: nothing can be verified, nothing may be shown. */
  geocodeDown: boolean;
  /** Drive mode: ORS failed twice with no success yet. Nothing was verified, nothing may be shown (D10). */
  driveDown: boolean;
  /** Why verification ended early; null = every idea was handled or 5 cards were found. */
  stoppedBy: "time" | "climate_cap" | null;
  climateMisses: number;
  /** Drive mode: ORS lookups started (cache hits included), for the event. */
  driveLookups: number;
  /** Drive mode: anchors of ideas whose drive was never verified (a failed or skipped lookup). "Show others" may propose them again. */
  uncheckedAnchors: string[];
};

type Resolved = { idea: Idea; place: GeoPlace; fetchedAt: string; stale: boolean; flight: ReturnType<typeof flightOf> };
const flightOf = (a: ReturnType<typeof assessFlight>) => (a.pass ? { flight: a.flight, nearAirport: a.nearAirport } : null);

/**
 * Verifies the ideas, cheapest step first (spec section 5). Only a real negative result drops a card; a provider
 * failure shows "not checked" and the card stays. The exceptions are geocoding and, in drive mode, the drive itself:
 * without them nothing can be shown (spec find-destinations-drive [D10]). No AeroDataBox call, no Overpass network query.
 */
export async function verifyIdeas(i: VerifyInput, deps: VerifyDeps = defaultVerifyDeps): Promise<VerifyOutcome> {
  const drops: DropCounts = {};
  const bump = (r: DropReason) => {
    drops[r] = (drops[r] ?? 0) + 1;
  };
  const deadline = deps.now() + VERIFY_BUDGET_MS;
  const ctx: FactsCtx = { userId: i.userId, locale: i.lang, today: i.today };
  const searchInterests = selectSearchInterests(i.interests);

  // Steps 1 and 2 for all ideas in parallel (step 2 needs no network).
  const lookups = await Promise.all(
    i.ideas.map(async (idea) => {
      const a = await resolveAnchor(idea, i.lang, i.userId, deps);
      if (a.status === "failed") return { idea, failed: true as const };
      if (a.status === "not_found") return { idea, failed: false as const, place: null, fetchedAt: "", stale: false };
      return { idea, failed: false as const, place: a.place, fetchedAt: a.fetchedAt, stale: a.stale };
    }),
  );
  const geocodeDown = lookups.length > 0 && lookups.every((l) => l.failed);
  if (geocodeDown) {
    return { cards: [], drops, reasonsRemoved: 0, geocodeDown: true, driveDown: false, stoppedBy: null, climateMisses: 0, driveLookups: 0, uncheckedAnchors: [] };
  }

  const survivors: Resolved[] = [];
  const geocodeUnchecked: string[] = [];
  for (const l of lookups) {
    if (l.failed) {
      bump("geocode_failed"); // a provider failure for this one idea: it cannot be shown, but it is not "not found"
      if (i.drive) geocodeUnchecked.push(l.idea.anchor); // never checked: "Show others" may propose it again
      continue;
    }
    if (!l.place) {
      bump("not_found");
      continue;
    }
    // Drive mode: only the straight-line cutoff here (no network); ORS decides in `verifyOne`.
    const assessed = i.drive
      ? assessDrive(l.place, i.drive.home, i.drive.maxHours)
      : assessFlight(l.place, { origins: i.origins, maxHours: i.maxHours });
    if (!assessed.pass) {
      bump("too_far");
      continue;
    }
    if (i.existing.some((c) => c.geoId === l.place!.geoId) || isDuplicate(l.place, survivors.map((s) => s.place))) {
      bump("duplicate");
      continue;
    }
    survivors.push({ idea: l.idea, place: l.place, fetchedAt: l.fetchedAt, stale: l.stale, flight: i.drive ? null : flightOf(assessed as ReturnType<typeof assessFlight>) });
  }

  // Steps 3 and 4 in idea order, two at a time, until 5 cards or the time budget.
  let misses = 0;
  let timeUp = false;
  let stoppedBy: VerifyOutcome["stoppedBy"] = null;
  let reasonsRemoved = 0;
  /** Miss cap: refuses cold lookups only. Ideas whose climate is cached are still verified after it. */
  const takeMiss = () => {
    if (misses >= MAX_CLIMATE_MISSES) return false;
    misses += 1;
    return true;
  };

  /** Drive lookups: two failures with no success yet mean ORS is down, so asking more only burns requests. */
  let driveLookups = 0;
  let driveFailures = 0;
  let driveSuccesses = 0;
  let driveConsecutiveFailures = 0;
  const uncheckedAnchors: string[] = [...geocodeUnchecked];
  const driveDown = () => driveSuccesses === 0 && driveFailures >= 2;
  const driveStopped = () => driveDown() || driveConsecutiveFailures >= DRIVE_MAX_CONSECUTIVE_FAILURES;

  const built: { index: number; card: SuggestionCard }[] = [];
  let next = 0;

  async function verifyOne(s: Resolved): Promise<SuggestionCard | DropReason | "skipped"> {
    // First step in drive mode, before climate: a place out of range must not use one of the climate misses (D9).
    let drive: SuggestionCard["drive"] = null;
    if (i.drive) {
      driveLookups += 1;
      const res = await deps.driveRoute(i.drive.home, s.place, ctx);
      if (!res.ok) {
        driveFailures += 1;
        driveConsecutiveFailures += 1;
        uncheckedAnchors.push(s.idea.anchor);
        return "drive_failed"; // a provider failure, never a real negative; the pipeline stops if all fail
      }
      driveSuccesses += 1;
      driveConsecutiveFailures = 0;
      if (!res.data.road) return "no_road";
      if (res.data.min > driveMaxMin(i.drive.maxHours)) return "too_far";
      drive = { min: res.data.min, km: res.data.km, source: "openrouteservice", fetchedAt: res.fetchedAt, stale: res.stale };
    }
    let climate: SuggestionCard["climate"] = null;
    if (i.months.length > 0) {
      let refused = false;
      const res = await deps.climate(s.place, ctx, () => {
        refused = !takeMiss();
        return !refused;
      });
      if (!res.ok && refused) {
        // The cap, not a provider failure: this place is not verified further and not shown (spec [D9]).
        if (!stoppedBy) stoppedBy = "climate_cap";
        return "skipped";
      }
      if (res.ok) {
        const mean = climateMean(res.data, i.months);
        if (mean && !passesAllClimate(searchInterests, mean)) return "climate";
        climate = {
          status: "ok",
          months: res.data.filter((m) => i.months.includes(m.month)),
          period: { ...CLIMATE_PERIOD },
          source: "open_meteo",
          fetchedAt: res.fetchedAt,
          stale: res.stale,
        };
      } else {
        climate = { status: "not_checked" }; // the provider failed: not a negative result
      }
    }
    // The name is model text too: same filter as the reason; a banned or empty name falls back to the verified place.
    const nameClean = cleanReason(s.idea.name);
    const name = (nameClean.reason ?? s.place.name).slice(0, 80);
    const kind = kindOf(name, s.idea.anchor, s.place.name);
    const pois = await Promise.all(
      searchInterests.map(async (interest): Promise<SuggestionCard["pois"][number] | "no_poi"> => {
        const v = VERIFIABILITY[interest];
        if (v.class === "none") return { status: "not_checked", interest };
        const found = await deps.pois(interest, s.place, DEFAULT_RADIUS_KM[kind], ctx, v.class !== "cache");
        if (!found || !found.result.ok) return { status: "not_checked", interest };
        const count = found.result.data.length;
        if (v.class === "place" && count < v.min) return "no_poi"; // a real negative: the lookup worked and found too few
        return { status: "ok", interest, count, radiusKm: found.radiusKm, source: "osm", fetchedAt: found.result.fetchedAt, stale: found.result.stale };
      }),
    );
    if (pois.includes("no_poi")) return "no_poi";
    const cleaned = cleanReason(s.idea.reason);
    if (cleaned.removed) reasonsRemoved += 1;
    return {
      id: `g${s.place.geoId}`,
      round: i.round,
      name,
      reason: cleaned.reason,
      kind,
      geoId: s.place.geoId,
      placeName: s.place.name,
      countryCode: s.idea.cc.toUpperCase(),
      admin1: s.place.admin1,
      place: { source: "geonames", fetchedAt: s.fetchedAt, stale: s.stale },
      flight: s.flight?.flight ?? null,
      nearAirport: s.flight?.nearAirport ?? false,
      ...(drive ? { drive } : {}),
      climate,
      pois: pois.filter((p): p is Exclude<typeof p, "no_poi"> => p !== "no_poi"),
    };
  }

  async function worker() {
    while (next < survivors.length && built.length < MAX_CARDS_PER_ROUND && !timeUp && !driveStopped()) {
      if (deps.now() >= deadline) {
        timeUp = true;
        stoppedBy = "time";
        return;
      }
      const index = next++;
      const out = await verifyOne(survivors[index]);
      if (out === "skipped") continue;
      if (typeof out === "string") bump(out);
      else built.push({ index, card: out });
    }
  }
  await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, () => worker()));

  const cards = built
    .sort((a, b) => a.index - b.index)
    .slice(0, MAX_CARDS_PER_ROUND)
    .map((b) => b.card);
  // Survivors no lookup reached (5 cards found, time up, or the lookups were stopped) were never checked: "Show others"
  // may propose them again. They count as drive_failed only when too many lookups failed.
  if (i.drive) {
    for (const s of survivors.slice(next)) {
      uncheckedAnchors.push(s.idea.anchor);
      if (driveStopped() && !driveDown()) bump("drive_failed");
    }
  }
  if (driveDown()) return { cards: [], drops, reasonsRemoved: 0, geocodeDown: false, driveDown: true, stoppedBy: null, climateMisses: misses, driveLookups, uncheckedAnchors };
  return { cards, drops, reasonsRemoved, geocodeDown: false, driveDown: false, stoppedBy, climateMisses: misses, driveLookups, uncheckedAnchors };
}
