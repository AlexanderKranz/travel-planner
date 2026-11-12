import { z } from "zod";
import type { ActivityGroupLookup, CafeLookup, PlaceGroup, RestaurantLookup, StopFacts, TripFacts } from "@/lib/domain/facts";
import type { TripPurpose } from "@/lib/domain/purpose";
import { DEFAULT_RADIUS_KM, type Trip } from "@/lib/domain/trip";
import { ACTIVITY_GROUPS, ACTIVITY_TYPES, typesInGroup, type ActivityType } from "@/lib/facts/activity-types";
import { groupPending, type BlockingScope } from "@/lib/plan/places-pending";
import { interestsForTrip, radiusForInterest, sourceFor, tripRadiusKm } from "@/lib/facts/interest-sources";
import { LANDMARK_RADIUS_KM } from "@/lib/facts/landmarks";

/** A search is retried in the background for at most this long (spec activities addendum 2, R1). */
export const RETRY_WINDOW_MS = 30 * 60_000;
/** Jobs enqueued by one call (interests max 4 + 3 groups + restaurants + cafes, with headroom). */
export const MAX_ENQUEUE = 12;

const coord = z.number().min(-180).max(180);
const Dest = z.object({ lat: coord, lon: coord, kind: z.enum(["city", "region"]) });
const Point = z.object({ lat: coord, lon: coord });

/** Normalized parameters to rerun one lookup. No user, trip or text: coordinates, kinds and keys only. */
export const RetrySpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interest"), interest: z.string().min(1).max(40), lat: coord, lon: coord, radiusKm: z.number().min(1).max(200) }),
  // `wanted`: the wished types of this group (empty = a group-only wish: every part is fetched). A retry fetches only
  // what was asked for, and the job is done when those are complete.
  z.object({ kind: z.literal("activity_group"), group: z.enum(ACTIVITY_GROUPS), dest: Dest, wanted: z.array(z.enum(ACTIVITY_TYPES)).max(30).default([]) }),
  z.object({ kind: z.literal("restaurants"), dest: Dest, near: Point.optional() }),
  z.object({ kind: z.literal("cafes"), dest: Dest, near: Point.optional() }),
]);
export type RetrySpec = z.infer<typeof RetrySpec>;

const r3 = (n: number) => Number(n.toFixed(3));
const round = (p: { lat: number; lon: number }) => ({ lat: r3(p.lat), lon: r3(p.lon) });
type DestLike = { lat: number; lon: number; kind: "city" | "region" };
const roundDest = (d: DestLike) => ({ ...round(d), kind: d.kind });

/** Stable dedupe key: the same lookup (same rounded point, radius-deciding fields) always gives the same key. */
export function retryKey(s: RetrySpec): string {
  switch (s.kind) {
    case "interest":
      return `interest:${s.interest}:${r3(s.lat)}:${r3(s.lon)}:${s.radiusKm}`;
    case "activity_group":
      return `activities:${s.group}:${r3(s.dest.lat)}:${r3(s.dest.lon)}:${[...s.wanted].sort().join(",")}`;
    default:
      return s.near
        ? `${s.kind}:near:${r3(s.near.lat)}:${r3(s.near.lon)}`
        : `${s.kind}:${r3(s.dest.lat)}:${r3(s.dest.lon)}:${s.dest.kind}`;
  }
}

export type RetryJob = { kind: RetrySpec["kind"]; cache_key: string; params: RetrySpec };
const job = (s: RetrySpec): RetryJob => ({ kind: s.kind, cache_key: retryKey(s), params: s });

/** Pending in the sense of `places-pending.ts`: failed, or skipped because the budget ran out. */
const notLoaded = (l: { status: string; reason?: string }) => l.status === "error" || (l.status === "skipped" && l.reason === "cache_only");

const geo = (trip: Trip): DestLike | null => (trip.destination.kind === "freetext" ? null : trip.destination);

/** Jobs for activity groups, restaurants and cafés that did not load. `near` is the point of a change request. */
export function jobsForActivityLookups(
  dest: DestLike | null,
  loaded: { activities?: ActivityGroupLookup[]; restaurants?: RestaurantLookup; cafes?: CafeLookup },
  near?: { restaurants?: { lat: number; lon: number }; cafes?: { lat: number; lon: number } },
  scope?: BlockingScope,
): RetryJob[] {
  if (!dest) return [];
  const d = roundDest(dest);
  const out: RetrySpec[] = [];
  // Same blocking scope as `places_pending`: named types only, open-wish extras never enqueue.
  for (const g of loaded.activities ?? []) {
    if (!groupPending(g, scope)) continue;
    const inGroup = new Set(typesInGroup(g.group));
    const wanted = scope ? [...scope.types].filter((t): t is ActivityType => inGroup.has(t)) : [];
    out.push({ kind: "activity_group", group: g.group, dest: d, wanted });
  }
  if (loaded.restaurants && notLoaded(loaded.restaurants)) {
    out.push({ kind: "restaurants", dest: d, ...(near?.restaurants ? { near: round(near.restaurants) } : {}) });
  }
  if (loaded.cafes && notLoaded(loaded.cafes)) {
    out.push({ kind: "cafes", dest: d, ...(near?.cafes ? { near: round(near.cafes) } : {}) });
  }
  return out.map(job);
}

/**
 * City tour landmarks (`src/lib/server/tour/landmarks.ts`) reuse the `interest` job kind with this reserved name, so
 * the table's `kind` check needs no migration; the worker branches on it. Never an interest key.
 */
export const LANDMARKS_JOB_INTEREST = "landmarks";

/** The job that fetches a city point's landmarks (Overpass, then Wikidata sitelinks). */
export function landmarksJob(p: { lat: number; lon: number }): RetryJob {
  return job({ kind: "interest", interest: LANDMARKS_JOB_INTEREST, ...round(p), radiusKm: LANDMARK_RADIUS_KM });
}

/** Jobs for interest lookups of a change request (issue #151) that failed: same radius rule as the plan's. */
export function jobsForInterests(dest: Extract<Trip["destination"], { lat: number }> | null, groups: readonly PlaceGroup[]): RetryJob[] {
  if (!dest) return [];
  const base = tripRadiusKm(dest);
  return groups
    .filter((g) => g.status === "error" && sourceFor(g.interest).source === "osm")
    .map((g) => job({ kind: "interest", interest: g.interest, ...round(dest), radiusKm: radiusForInterest(g.interest, base) }));
}

/**
 * Jobs for every lookup of a trip's facts that failed: interests with an OSM source, activity groups, restaurants,
 * cafés. When all interests failed, the places fact is `unavailable` and lists no groups: then every interest of the
 * purpose that has a source is retried.
 */
export function jobsForTripFacts(
  trip: Trip,
  purpose: TripPurpose | null,
  facts: Pick<TripFacts, "places" | "activities" | "restaurants" | "cafes">,
  scope?: BlockingScope,
): RetryJob[] {
  const dest = geo(trip);
  if (!dest) return [];
  const base = tripRadiusKm(trip.destination as Extract<Trip["destination"], { lat: number }>);
  const failed: string[] = [];
  if (facts.places.status === "ok") {
    for (const g of facts.places.data.groups) if (g.status === "error") failed.push(g.interest);
  } else if (facts.places.reason === "provider_error") {
    failed.push(...interestsForTrip(purpose?.guided, purpose?.tags).keys);
  }
  const interests = failed
    .filter((k, i) => failed.indexOf(k) === i)
    .map((k) => k as Parameters<typeof sourceFor>[0])
    .filter((k) => sourceFor(k).source === "osm")
    .map((k) => job({ kind: "interest", interest: k, ...round(dest), radiusKm: radiusForInterest(k, base) }));
  return [...interests, ...jobsForActivityLookups(dest, facts, undefined, scope)].slice(0, MAX_ENQUEUE);
}

/**
 * Jobs for the lookups around trip stops that failed or were skipped (port-places [P7], R2: the stop point is the
 * job's point, no new job kind): interests with an OSM source, restaurants, cafés. The retry worker, unlike a
 * plan run, may query Overpass over the network. Stops without a point (not found, failed, capped) have none.
 */
export function jobsForStops(stops: readonly Pick<StopFacts, "stop" | "places" | "restaurants" | "cafes">[]): RetryJob[] {
  const out: RetryJob[] = [];
  for (const f of stops) {
    const p = f.stop.point;
    if (f.stop.role !== "stop" || f.stop.status !== "ok" || !p) continue;
    const dest = { lat: p.lat, lon: p.lon, kind: "city" as const };
    const radius = tripRadiusKm({ ...dest, radiusKm: DEFAULT_RADIUS_KM.city } as Extract<Trip["destination"], { lat: number }>);
    for (const g of f.places) {
      if (g.status === "error" && sourceFor(g.interest).source === "osm") {
        out.push(job({ kind: "interest", interest: g.interest, ...round(dest), radiusKm: radiusForInterest(g.interest, radius) }));
      }
    }
    if (f.restaurants && notLoaded(f.restaurants)) out.push(job({ kind: "restaurants", dest: roundDest(dest) }));
    if (f.cafes && notLoaded(f.cafes)) out.push(job({ kind: "cafes", dest: roundDest(dest) }));
  }
  return out;
}
