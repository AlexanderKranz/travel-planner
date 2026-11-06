import { z } from "zod";
import type { ActivityGroupLookup, CafeLookup, RestaurantLookup, TripFacts } from "@/lib/domain/facts";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import { ACTIVITY_GROUPS } from "@/lib/facts/activity-types";
import { interestsForTrip, radiusForInterest, sourceFor, tripRadiusKm } from "@/lib/facts/interest-sources";

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
  z.object({ kind: z.literal("activity_group"), group: z.enum(ACTIVITY_GROUPS), dest: Dest }),
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
      return `activities:${s.group}:${r3(s.dest.lat)}:${r3(s.dest.lon)}`;
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
): RetryJob[] {
  if (!dest) return [];
  const d = roundDest(dest);
  const out: RetrySpec[] = [];
  for (const g of loaded.activities ?? []) if (notLoaded(g)) out.push({ kind: "activity_group", group: g.group, dest: d });
  if (loaded.restaurants && notLoaded(loaded.restaurants)) {
    out.push({ kind: "restaurants", dest: d, ...(near?.restaurants ? { near: round(near.restaurants) } : {}) });
  }
  if (loaded.cafes && notLoaded(loaded.cafes)) {
    out.push({ kind: "cafes", dest: d, ...(near?.cafes ? { near: round(near.cafes) } : {}) });
  }
  return out.map(job);
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
  return [...interests, ...jobsForActivityLookups(dest, facts)].slice(0, MAX_ENQUEUE);
}
