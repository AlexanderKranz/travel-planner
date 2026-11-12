import { describe, expect, it } from "vitest";
import type { Trip } from "@/lib/domain/trip";
import { INTEREST_KEYS } from "@/lib/domain/interests";
import { jobsForActivityLookups, jobsForInterests, jobsForStops, jobsForTripFacts, landmarksJob, LANDMARKS_JOB_INTEREST, overpassJob, retryKey, RetrySpec, type RetryJob } from "./places-retry";

const dest = { lat: 49.0123456, lon: 12.1012345, kind: "city" as const };
const trip = {
  destination: { kind: "city", name: "X", placeName: "X", geoId: 1, countryCode: "DE", admin1: null, lat: 49.0123456, lon: 12.1012345 },
} as unknown as Trip;
const freetext = { destination: { kind: "freetext", name: "Somewhere" } } as unknown as Trip;

const okPlaces = (groups: unknown[]) => ({ status: "ok", data: { radiusKm: 15, groups, customInterests: [] }, source: "osm", fetchedAt: "x", stale: false }) as never;

describe("retryKey", () => {
  it("rounds the point and ignores noise, so the same lookup dedupes", () => {
    const a = retryKey({ kind: "restaurants", dest: { lat: 49.01201, lon: 12.1011, kind: "city" } });
    const b = retryKey({ kind: "restaurants", dest: { lat: 49.01199, lon: 12.10104, kind: "city" } });
    expect(a).toBe(b);
  });
  it("separates kinds, groups, near and region", () => {
    const keys = new Set([
      retryKey({ kind: "restaurants", dest }),
      retryKey({ kind: "cafes", dest }),
      retryKey({ kind: "restaurants", dest: { ...dest, kind: "region" } }),
      retryKey({ kind: "restaurants", dest, near: { lat: 49.02, lon: 12.11 } }),
      retryKey({ kind: "activity_group", group: "indoor", dest, wanted: [] }),
      retryKey({ kind: "activity_group", group: "outdoor", dest, wanted: [] }),
      retryKey({ kind: "activity_group", group: "indoor", dest, wanted: ["bowling"] }),
    ]);
    expect(keys.size).toBe(7);
  });
});

describe("jobsForActivityLookups", () => {
  const err = { status: "error" as const, places: [] };
  it("enqueues error and cache_only skips, never ok, empty or no_location", () => {
    const jobs = jobsForActivityLookups(
      dest,
      {
        activities: [
          { group: "indoor", ...err },
          { group: "outdoor", status: "skipped", places: [], reason: "cache_only" },
          { group: "going_out", status: "empty", places: [], fetchedAt: "x" },
        ],
        restaurants: { status: "skipped", restaurants: [], reason: "no_location" },
        cafes: { status: "error", cafes: [] },
      },
    );
    expect(jobs.map((j) => j.kind)).toEqual(["activity_group", "activity_group", "cafes"]);
    expect(jobs.map((j) => (j.params as { group?: string }).group)).toEqual(["indoor", "outdoor", undefined]);
  });
  it("a partial group enqueues only when a named type failed, with the wished types as `wanted`", () => {
    const partial = { group: "indoor", status: "ok", places: [], partial: true, typeStatus: { bowling: "ok", cinema: "error" } } as never;
    expect(jobsForActivityLookups(dest, { activities: [partial] }, undefined, { types: new Set(["bowling"]) })).toEqual([]);
    const jobs = jobsForActivityLookups(dest, { activities: [partial] }, undefined, { types: new Set(["cinema", "bowling", "hiking" as never]) });
    expect(jobs.map((j) => j.kind)).toEqual(["activity_group"]);
    expect((jobs[0].params as { wanted: string[] }).wanted.sort()).toEqual(["bowling", "cinema"]);
  });
  it("an open wish's extra types never enqueue; a group-only wish does", () => {
    const failedExtra = { group: "indoor", status: "ok", places: [], typeStatus: { bowling: "ok", cinema: "error" } } as never;
    expect(jobsForActivityLookups(dest, { activities: [failedExtra] }, undefined, { types: new Set(["bowling"]) })).toEqual([]);
    const groupOnly = { group: "indoor", status: "error", places: [], typeStatus: { bowling: "error", cinema: "error" } } as never;
    const jobs = jobsForActivityLookups(dest, { activities: [groupOnly] }, undefined, { types: new Set(), groups: new Set(["indoor"]) });
    expect((jobs[0].params as { wanted: string[] }).wanted).toEqual([]);
  });
  it("keeps the near point of a change request and rounds it", () => {
    const [j] = jobsForActivityLookups(dest, { restaurants: { status: "error", restaurants: [] } }, { restaurants: { lat: 49.123456, lon: 12.654321 } });
    expect(j.params).toMatchObject({ kind: "restaurants", near: { lat: 49.123, lon: 12.654 } });
    expect(j.cache_key).toContain("near");
  });
  it("nothing for a free-text destination", () => {
    expect(jobsForActivityLookups(null, { restaurants: { status: "error", restaurants: [] } })).toEqual([]);
  });
  it("every job passes the schema and holds no free text", () => {
    const jobs = jobsForActivityLookups(dest, { activities: [{ group: "indoor", ...err } as never], restaurants: { status: "error", restaurants: [] } });
    for (const j of jobs) expect(RetrySpec.safeParse(j.params).success).toBe(true);
    expect(JSON.stringify(jobs)).not.toMatch(/Somewhere|name/);
  });
});

describe("jobsForTripFacts", () => {
  it("interests that errored (with a source) plus failed activity lookups", () => {
    const jobs: RetryJob[] = jobsForTripFacts(trip, null, {
      places: okPlaces([
        { interest: "museums", status: "error" },
        { interest: "golf", status: "ok", candidates: [], fetchedAt: "x", stale: false },
      ]),
      restaurants: { status: "error", restaurants: [] },
    });
    expect(jobs.map((j) => j.kind)).toEqual(["interest", "restaurants"]);
    expect(jobs[0].params).toMatchObject({ interest: "museums", lat: 49.012, lon: 12.101 });
  });
  it("no jobs for a free-text destination or when everything loaded", () => {
    expect(jobsForTripFacts(freetext, null, { places: { status: "unavailable", reason: "no_location" } as never })).toEqual([]);
    expect(jobsForTripFacts(trip, null, { places: okPlaces([]) })).toEqual([]);
  });
  it("when every interest failed, the purpose's interests with a source are retried", () => {
    const jobs = jobsForTripFacts(trip, { guided: { interests: ["museums"] } } as never, { places: { status: "unavailable", reason: "provider_error", source: "osm" } as never });
    expect(jobs.length).toBeGreaterThan(0);
    expect(new Set(jobs.map((j) => j.cache_key)).size).toBe(jobs.length);
  });
});

describe("jobsForInterests (issue #151)", () => {
  const geo = trip.destination as Parameters<typeof jobsForInterests>[0];
  it("failed interests with a source only, with the plan's radius rule; none for a free-text destination", () => {
    const jobs = jobsForInterests(geo, [
      { interest: "golf", status: "error" },
      { interest: "beach", status: "empty", fetchedAt: "x", stale: false },
      { interest: "nightlife", status: "error" },
    ]);
    expect(jobs.map((j) => j.params)).toEqual([{ kind: "interest", interest: "golf", lat: 49.012, lon: 12.101, radiusKm: 40 }]);
    expect(jobs[0].cache_key).toBe(jobsForTripFacts(trip, null, { places: okPlaces([{ interest: "golf", status: "error" }]) })[0].cache_key);
    expect(jobsForInterests(null, [{ interest: "golf", status: "error" }])).toEqual([]);
  });
});

describe("jobsForStops (port-places [P7], R2: the stop point is the job's point)", () => {
  const stop = (id: string, over: Record<string, unknown> = {}) => ({
    stop: { id, name: id, days: [2], role: "stop" as const, point: { lat: 48.20849, lon: 16.37208, geoId: 1 }, status: "ok" as const, ...over },
    places: [] as never[],
  });

  it("queues failed interests, restaurants and cafés at the stop point, with the stop radius (city, 15 km base)", () => {
    const jobs = jobsForStops([
      {
        ...stop("s1"),
        places: [{ interest: "family_activities", status: "error" }, { interest: "general", status: "empty", fetchedAt: "f", stale: false }] as never[],
        restaurants: { status: "error", restaurants: [] },
        cafes: { status: "skipped", reason: "cache_only", cafes: [] },
      },
    ]);
    expect(jobs.map((j) => j.kind)).toEqual(["interest", "restaurants", "cafes"]);
    expect(jobs[0].params).toMatchObject({ kind: "interest", interest: "family_activities", lat: 48.208, lon: 16.372 });
    expect(jobs[1].params).toEqual({ kind: "restaurants", dest: { lat: 48.208, lon: 16.372, kind: "city" } });
    for (const j of jobs) expect(RetrySpec.safeParse(j.params).success).toBe(true);
  });

  it("the restaurant job of a stop shares its key with a city trip to that town (dedupe)", () => {
    const [stopJob] = jobsForStops([{ ...stop("s1"), restaurants: { status: "error", restaurants: [] } }]);
    const [cityJob] = jobsForActivityLookups({ lat: 48.20849, lon: 16.37208, kind: "city" }, { restaurants: { status: "error", restaurants: [] } });
    expect(stopJob.cache_key).toBe(cityJob.cache_key);
  });

  it("nothing for lookups that worked, for destination, not found, failed or capped stops, or without a point", () => {
    expect(jobsForStops([{ ...stop("s1"), restaurants: { status: "ok", restaurants: [] } }])).toEqual([]);
    expect(jobsForStops([{ ...stop("s1"), restaurants: { status: "skipped", reason: "no_location", restaurants: [] } }])).toEqual([]);
    for (const over of [{ role: "destination" }, { status: "not_found" }, { status: "error" }, { status: "cap" }, { point: undefined }]) {
      expect(jobsForStops([{ ...stop("s1", over), restaurants: { status: "error", restaurants: [] } }])).toEqual([]);
    }
  });

  it("an interest without an OSM source is never retried", () => {
    expect(jobsForStops([{ ...stop("s1"), places: [{ interest: "christmas_markets", status: "error" }] as never[] }])).toEqual([]);
  });
});

describe("landmarksJob (city tours)", () => {
  it("an interest job with the reserved name, rounded point, 8 km; never an interest key", () => {
    expect(landmarksJob({ lat: 50.11552, lon: 8.68417 })).toEqual({
      kind: "interest",
      cache_key: "interest:landmarks:50.116:8.684:8",
      params: { kind: "interest", interest: "landmarks", lat: 50.116, lon: 8.684, radiusKm: 8 },
    });
    expect(RetrySpec.safeParse(landmarksJob({ lat: 48.2, lon: 16.37 }).params).success).toBe(true);
    expect((INTEREST_KEYS as readonly string[]).includes(LANDMARKS_JOB_INTEREST)).toBe(false);
  });
});

describe("overpassJob (interests with overpassFirst, issue #172)", () => {
  it("own dedupe key next to the normal interest job; valid spec", () => {
    const j = overpassJob({ lat: 41.38879, lon: 2.15899 }, "general", 15);
    expect(j).toEqual({
      kind: "interest",
      cache_key: "interest:general:41.389:2.159:15:overpass",
      params: { kind: "interest", interest: "general", lat: 41.389, lon: 2.159, radiusKm: 15, overpass: true },
    });
    expect(RetrySpec.safeParse(j.params).success).toBe(true);
    expect(retryKey({ kind: "interest", interest: "general", lat: 41.389, lon: 2.159, radiusKm: 15 })).toBe("interest:general:41.389:2.159:15");
  });
});
