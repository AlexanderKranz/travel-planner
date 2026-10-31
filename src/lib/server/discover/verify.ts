import "server-only";
import { MAX_CARDS_PER_ROUND, type DropCounts, type DropReason, type SuggestionCard } from "@/lib/domain/destination-search";
import type { MonthlyClimate, PlaceCandidate } from "@/lib/domain/facts";
import type { FactsCtx } from "@/lib/domain/facts";
import type { GeoPlace } from "@/lib/domain/geo";
import type { InterestKey } from "@/lib/domain/interests";
import { DEFAULT_RADIUS_KM } from "@/lib/domain/trip";
import { climateMean, passesAllClimate } from "@/lib/discover/climate-rules";
import { assessFlight } from "@/lib/discover/flight";
import { isDuplicate, kindOf, pickAnchorPlace } from "@/lib/discover/names";
import { cleanReason } from "@/lib/discover/reason";
import { selectSearchInterests, VERIFIABILITY } from "@/lib/discover/verifiability";
import { CLIMATE_PERIOD } from "@/lib/facts/climate";
import { searchPlacesCached } from "@/lib/integrations/open-meteo-geocoding";
import type { CachedResult } from "../api-cache";
import type { Idea } from "../ai/destination-ideas";
import { getClimateAt } from "../facts/weather";
import { getPlacesAt } from "../facts/places";

/** Time for steps 3 and 4 of one search; ideas not reached are not shown (spec section 5). */
export const VERIFY_BUDGET_MS = 45_000;
/** Cold climate lookups per search: Open-Meteo's per-minute limit (spec [D9]). */
export const MAX_CLIMATE_MISSES = 5;
export const VERIFY_CONCURRENCY = 2;

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
  now: () => number;
};

export const defaultVerifyDeps: VerifyDeps = {
  geocode: (anchor, lang, userId) => searchPlacesCached(anchor, lang, { userId }),
  climate: (point, ctx, fetchAllowed) => getClimateAt(point, ctx, { fetchAllowed }),
  pois: (interest, point, baseRadiusKm, ctx, networkAllowed) => getPlacesAt(interest, point, baseRadiusKm, ctx, { networkAllowed }),
  now: () => Date.now(),
};

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
  /** Active flight limit in hours; null = no radius filter. */
  maxHours: number | null;
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
  /** Why verification ended early; null = every idea was handled or 5 cards were found. */
  stoppedBy: "time" | "climate_cap" | null;
  climateMisses: number;
};

type Resolved = { idea: Idea; place: GeoPlace; fetchedAt: string; stale: boolean; flight: ReturnType<typeof flightOf> };
const flightOf = (a: ReturnType<typeof assessFlight>) => (a.pass ? { flight: a.flight, nearAirport: a.nearAirport } : null);

/**
 * Verifies the ideas, cheapest step first (spec section 5). Only a real negative result drops a card; a provider
 * failure shows "not checked" and the card stays. The one exception is geocoding: without it nothing can be shown.
 * No AeroDataBox call, no Overpass network query.
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
      const res = await deps.geocode(idea.anchor, i.lang, i.userId);
      if (!res.ok) return { idea, failed: true as const };
      return { idea, failed: false as const, place: pickAnchorPlace(res.data, idea.anchor, idea.cc), fetchedAt: res.fetchedAt, stale: res.stale };
    }),
  );
  const geocodeDown = lookups.length > 0 && lookups.every((l) => l.failed);
  if (geocodeDown) {
    return { cards: [], drops, reasonsRemoved: 0, geocodeDown: true, stoppedBy: null, climateMisses: 0 };
  }

  const survivors: Resolved[] = [];
  for (const l of lookups) {
    if (l.failed) {
      bump("geocode_failed"); // a provider failure for this one idea: it cannot be shown, but it is not "not found"
      continue;
    }
    if (!l.place) {
      bump("not_found");
      continue;
    }
    const assessed = assessFlight(l.place, { origins: i.origins, maxHours: i.maxHours });
    if (!assessed.pass) {
      bump("too_far");
      continue;
    }
    if (i.existing.some((c) => c.geoId === l.place!.geoId) || isDuplicate(l.place, survivors.map((s) => s.place))) {
      bump("duplicate");
      continue;
    }
    survivors.push({ idea: l.idea, place: l.place, fetchedAt: l.fetchedAt, stale: l.stale, flight: flightOf(assessed) });
  }

  // Steps 3 and 4 in idea order, two at a time, until 5 cards or the time budget.
  let misses = 0;
  let capped = false;
  let stoppedBy: VerifyOutcome["stoppedBy"] = null;
  let reasonsRemoved = 0;
  const fetchAllowed = () => {
    if (misses >= MAX_CLIMATE_MISSES) {
      capped = true;
      return false;
    }
    misses += 1;
    return true;
  };

  const built: { index: number; card: SuggestionCard }[] = [];
  let next = 0;

  async function verifyOne(s: Resolved): Promise<SuggestionCard | DropReason> {
    let climate: SuggestionCard["climate"] = null;
    if (i.months.length > 0) {
      const res = await deps.climate(s.place, ctx, fetchAllowed);
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
        climate = { status: "not_checked" }; // provider failed or the miss cap was reached: not a negative result
      }
    }
    const kind = kindOf(s.idea.name, s.idea.anchor);
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
      name: (s.idea.name.trim() || s.place.name).slice(0, 80),
      reason: cleaned.reason,
      kind,
      geoId: s.place.geoId,
      placeName: s.place.name,
      countryCode: s.idea.cc.toUpperCase(),
      admin1: s.place.admin1,
      place: { source: "geonames", fetchedAt: s.fetchedAt, stale: s.stale },
      flight: s.flight?.flight ?? null,
      nearAirport: s.flight?.nearAirport ?? false,
      climate,
      pois: pois.filter((p): p is Exclude<typeof p, "no_poi"> => p !== "no_poi"),
    };
  }

  async function worker() {
    while (next < survivors.length && built.length < MAX_CARDS_PER_ROUND && !stoppedBy) {
      if (deps.now() >= deadline) {
        stoppedBy = "time";
        return;
      }
      const index = next++;
      const out = await verifyOne(survivors[index]);
      if (typeof out === "string") bump(out);
      else built.push({ index, card: out });
      if (capped && !stoppedBy) stoppedBy = "climate_cap";
    }
  }
  await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, () => worker()));

  const cards = built
    .sort((a, b) => a.index - b.index)
    .slice(0, MAX_CARDS_PER_ROUND)
    .map((b) => b.card);
  return { cards, drops, reasonsRemoved, geocodeDown: false, stoppedBy, climateMisses: misses };
}
