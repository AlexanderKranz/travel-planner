import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { Op, Reply } from "./test-db";

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  reply: (() => ({})) as (op: Op) => Reply,
  owner: "u1",
  stored: null as null | { result: unknown; result_hash: string | null },
  input: {} as unknown,
  gate: vi.fn(async () => true),
  matrix: vi.fn(),
  route: vi.fn(),
  peek: vi.fn(async () => null),
  reserve: vi.fn(),
  release: vi.fn(),
  logEvent: vi.fn(),
  cityPlaces: vi.fn(),
  getPlaceById: vi.fn(),
}));
vi.mock("../session", async () => {
  const { fakeDb } = await import("./test-db");
  return { getUserSession: async () => ({ userId: "u1", supabase: fakeDb("user", h.ops, (o) => h.reply(o)) }) };
});
vi.mock("../supabase/admin", async () => {
  const { fakeDb } = await import("./test-db");
  return { createSupabaseAdminClient: () => fakeDb("admin", h.ops, (o) => h.reply(o)) };
});
vi.mock("../facts/ors-quota", () => ({ orsTourGate: h.gate }));
vi.mock("../facts/tour-ors", () => ({ getTourMatrix: h.matrix, getTourRoute: h.route, peekTourMatrix: h.peek }));
vi.mock("../ai-slots", () => ({ reserveAiCall: h.reserve, releaseAiCall: h.release }));
vi.mock("../events", () => ({ logEvent: h.logEvent }));
vi.mock("./places", async (orig) => ({ ...(await orig<typeof import("./places")>()), cityPlaces: h.cityPlaces }));
vi.mock("@/lib/integrations/open-meteo-geocoding", () => ({ getPlaceById: h.getPlaceById }));

import { legKey, TourInput, type TourResult } from "@/lib/domain/tour";
import { parseTourMatrix, parseTourRoute } from "@/lib/integrations/openrouteservice";
import { tourInputHash } from "@/lib/tour/hash";
import { resetRateLimits } from "../rate-limit";
import { computeTour } from "./compute";

const TOUR = "11111111-1111-4111-8111-111111111111";
const fx = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../integrations/__fixtures__/ors-tour", `${name}.json`), "utf8"));
/** Spike points in the spike's order (matrix and Directions fixtures, Wien, 2026-11-12). */
const P = [
  { key: "osm:w1", name: "Stephansdom", lat: 48.2085, lon: 16.3731, source: "osm" as const },
  { key: "osm:w2", name: "Hofburg", lat: 48.2065, lon: 16.3655, source: "osm" as const },
  { key: "osm:w3", name: "Naschmarkt", lat: 48.199, lon: 16.363, source: "osm" as const },
  { key: "osm:w4", name: "Karlskirche", lat: 48.1981, lon: 16.3716, source: "osm" as const },
  { key: "osm:w5", name: "Oberes Belvedere", lat: 48.1915, lon: 16.381, source: "osm" as const },
  { key: "osm:n6", name: "Riesenrad", lat: 48.2166, lon: 16.3958, source: "osm" as const },
];
const MATRIX = parseTourMatrix(fx("matrix-foot-wien"), 6).durations;
const LEGS = parseTourRoute(fx("directions-foot-wien-fastest"), 6);
const okRoute = (n: number, extra: object = {}) => ({
  result: "ok",
  legs: Array.from({ length: n - 1 }, (_, i) => LEGS[i % LEGS.length]),
  fetchedAt: "2026-11-12T10:00:00.000Z",
  stale: false,
  cache: "miss",
  ...extra,
});
const WIEN = { geoId: 2761369, name: "Wien", featureCode: "PPLC", countryCode: "AT", admin1: null, lat: 48.20849, lon: 16.37208, timezone: "Europe/Vienna", population: 1, suggestedKind: "city" };

function row() {
  return {
    id: TOUR, owner_id: h.owner, title: null, input: h.input, trip_id: null, trip_day: null,
    result: h.stored?.result ?? null, result_hash: h.stored?.result_hash ?? null, computed_at: null,
    created_at: "2026-11-12T00:00:00Z", updated_at: "2026-11-12T00:00:00Z",
  };
}
const adminWrites = () => h.ops.filter((o) => o.client === "admin" && o.op === "update");
const orsCalls = () => h.gate.mock.calls.length + h.matrix.mock.calls.length + h.route.mock.calls.length;

beforeEach(() => {
  resetRateLimits();
  h.ops = [];
  h.owner = "u1";
  h.stored = null;
  h.input = TourInput.parse({ places: P });
  h.reply = (o) => {
    if (o.table === "profiles") return { data: { locale: "de" } };
    if (o.table === "city_tours" && o.client === "user") return { data: row() };
    if (o.table === "city_tours" && o.client === "admin") return { data: [{ updated_at: "2026-11-12T01:00:00Z" }] };
    return {};
  };
  h.gate.mockReset().mockResolvedValue(true);
  h.matrix.mockReset().mockResolvedValue({ durations: MATRIX, snappedM: [], fetchedAt: "2026-11-01T00:00:00.000Z", stale: false, cache: "hit" });
  h.route.mockReset().mockImplementation(async (_p: string, _o: string, pts: unknown[]) => okRoute(pts.length));
  h.peek.mockReset().mockResolvedValue(null);
  h.reserve.mockReset().mockResolvedValue({ ok: true, id: "slot1", pending: 0 });
  h.release.mockReset();
  h.logEvent.mockReset();
  h.cityPlaces.mockReset().mockResolvedValue({ places: [], pending: false, fetchedAt: "2026-11-02T00:00:00.000Z" });
  h.getPlaceById.mockReset().mockResolvedValue(WIEN);
});
afterEach(() => vi.useRealTimers());

describe("computeTour: access and short cuts", () => {
  it("a grantee (not the owner) cannot compute: no slot, no ORS call, no write", async () => {
    h.owner = "u2";
    expect(await computeTour(TOUR)).toEqual({ ok: false, error: "forbidden" });
    expect(orsCalls()).toBe(0);
    expect(h.reserve).not.toHaveBeenCalled();
    expect(adminWrites()).toHaveLength(0);
  });

  it("unchanged input → the stored result, 0 ORS calls, no slot taken", async () => {
    const stored: TourResult = { v: 1, order: ["osm:w1"], legs: [], totalMin: 10, fit: "none", sights: [{ key: "osm:n9", name: "x", lat: 1, lon: 1, leg: 0, m: 5, cat: "c" }], source: { ors: "x" } };
    h.stored = { result: stored, result_hash: tourInputHash(h.input as TourInput) };
    const res = await computeTour(TOUR);
    expect(res).toMatchObject({ ok: true, data: { unchanged: true, result: stored } });
    expect(orsCalls()).toBe(0);
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.cityPlaces).not.toHaveBeenCalled();
    expect(adminWrites()).toHaveLength(0);
  });

  it("unchanged input without sights: sights from the cache only (network off), no ORS call", async () => {
    const legs = [{ from: "osm:w1", to: "osm:w2", mode: "foot", route: "fastest", min: 9, km: 0.7, poly: LEGS[0].poly, s: "ok" }];
    const stored = { v: 1, order: ["osm:w1", "osm:w2"], legs, totalMin: 9, fit: "none", sights: [], source: { ors: "x" } };
    h.stored = { result: stored, result_hash: tourInputHash(h.input as TourInput) };
    h.cityPlaces.mockResolvedValue({ places: [], pending: true, fetchedAt: null });
    const res = await computeTour(TOUR);
    expect(res).toMatchObject({ ok: true, data: { unchanged: true, sightsPending: true } });
    expect(h.cityPlaces.mock.calls[0][2]).toMatchObject({ network: false });
    expect(orsCalls()).toBe(0);
  });

  it("ORS gate below the reserve → ors_unavailable, stored result kept, no call, slot released", async () => {
    const stored: TourResult = { v: 1, order: [], legs: [], totalMin: null, fit: "none", sights: [], source: { ors: "x" } };
    h.stored = { result: stored, result_hash: "0".repeat(64) };
    h.gate.mockResolvedValue(false);
    expect(await computeTour(TOUR)).toEqual({ ok: false, error: "ors_unavailable", result: stored, notRecomputed: true });
    expect(h.gate).toHaveBeenCalledWith(1, { needsMatrix: true });
    expect(h.matrix).not.toHaveBeenCalled();
    expect(h.route).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledWith("slot1");
    expect(adminWrites()).toHaveLength(0);
  });

  it("matrix unavailable (ORS down, no cached value) → ors_unavailable, nothing written, slot released", async () => {
    h.matrix.mockResolvedValue(null);
    expect(await computeTour(TOUR)).toMatchObject({ ok: false, error: "ors_unavailable", notRecomputed: true });
    expect(adminWrites()).toHaveLength(0);
    expect(h.release).toHaveBeenCalledWith("slot1");
  });

  it("a stored result with a failed leg is recomputed although the input is unchanged", async () => {
    const legs = [{ from: "osm:w1", to: "osm:w2", mode: "foot", route: "fastest", min: null, km: null, poly: null, s: "failed" }];
    h.stored = {
      result: { v: 1, order: ["osm:w1", "osm:w2"], legs, totalMin: null, fit: "none", sights: [], source: { ors: "x" } },
      result_hash: tourInputHash(h.input as TourInput),
    };
    const res = await computeTour(TOUR);
    expect(res).toMatchObject({ ok: true, data: { unchanged: false } });
    expect(h.route).toHaveBeenCalledTimes(1);
    expect(adminWrites()).toHaveLength(1);
  });
});

describe("computeTour: limits", () => {
  it("10 per minute in memory", async () => {
    for (let i = 0; i < 10; i++) await computeTour(TOUR);
    expect(await computeTour(TOUR)).toMatchObject({ ok: false, error: "rate_limited" });
  });

  it("20 per Berlin day (durable slot) → daily_limit with the next Berlin midnight", async () => {
    h.reserve.mockResolvedValue({ ok: false, reason: "day" });
    const res = await computeTour(TOUR);
    expect(res).toMatchObject({ ok: false, error: "daily_limit" });
    expect(res.ok === false && res.resetAt).toMatch(/T2[23]:00:00\.\d{3}Z$/);
    expect(h.reserve.mock.calls[0][0]).toMatchObject({ userId: "u1", task: "tour_compute", perMinute: 10, perDay: 20 });
    expect(orsCalls()).toBe(0);
  });

  it("unreadable limits fail closed", async () => {
    h.reserve.mockRejectedValue(new Error("db"));
    expect(await computeTour(TOUR)).toEqual({ ok: false, error: "failed" });
    expect(orsCalls()).toBe(0);
  });
});

describe("computeTour: pipeline", () => {
  it("optimizes over the matrix, one run = one Directions request, writes the snapshot with the secret key after the RLS read", async () => {
    const res = await computeTour(TOUR);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Held–Karp over the spike matrix: an open path over all six points.
    expect(new Set(res.data.result.order)).toEqual(new Set(P.map((p) => p.key)));
    expect(h.route).toHaveBeenCalledTimes(1);
    expect(h.route.mock.calls[0][0]).toBe("foot-walking");
    expect(h.route.mock.calls[0][2].map((p: { key: string }) => p.key)).toEqual(res.data.result.order);
    expect(res.data.result.legs.every((l) => l.s === "ok" && l.min !== null)).toBe(true);
    expect(res.data.result.totalMin).toBe(res.data.result.legs.reduce((s, l) => s + l.min!, 0) + 6 * 30);

    // Writes: none through the user session; exactly one admin update, scoped to the row read through RLS.
    expect(h.ops.filter((o) => o.client === "user" && o.op !== "select")).toHaveLength(0);
    const w = adminWrites();
    expect(w).toHaveLength(1);
    expect(Object.keys(w[0].payload as object).sort()).toEqual(["computed_at", "result", "result_hash"]);
    expect((w[0].payload as { result_hash: string }).result_hash).toBe(tourInputHash(h.input as TourInput));
    expect(w[0].eqs).toEqual([["id", TOUR], ["owner_id", "u1"], ["updated_at", "2026-11-12T00:00:00Z"]]);
    const readAt = h.ops.findIndex((o) => o.client === "user" && o.table === "city_tours");
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeLessThan(h.ops.indexOf(w[0]));
    expect(res.data.updatedAt).toBe("2026-11-12T01:00:00Z");

    expect(h.logEvent).toHaveBeenCalledWith({
      event: "tour.computed",
      userId: "u1",
      props: { points: 6, mode: "foot", route: "fastest", runs: 1, cacheHits: 1, fit: "none", failedLegs: 0 },
    });
  });

  it("25 places: heuristic order over the matrix, flagged as approximate; 16 points stay exact", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      key: `osm:n${100 + i}`, name: `Ort ${i + 1}`, lat: 48.19 + (i % 5) * 0.006, lon: 16.35 + Math.floor(i / 5) * 0.008, source: "osm" as const,
    }));
    const grid = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? 0 : 60 + Math.round(Math.hypot((i % 5) - (j % 5), Math.floor(i / 5) - Math.floor(j / 5)) * 400))),
      );
    h.input = TourInput.parse({ places: many });
    h.matrix.mockResolvedValue({ durations: grid(25), snappedM: [], fetchedAt: "2026-11-01T00:00:00.000Z", stale: false, cache: "hit" });
    const res = await computeTour(TOUR);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(new Set(res.data.result.order)).toEqual(new Set(many.map((p) => p.key)));
    // The matrix decided the order: clearly cheaper than the input order (row by row with jumps back).
    const g = grid(25);
    const idx = res.data.result.order.map((k) => Number(k.slice(5)) - 100);
    const cost = (seq: number[]) => seq.slice(1).reduce((s, j, i) => s + g[seq[i]][j], 0);
    expect(cost(idx)).toBeLessThan(cost([...Array(25).keys()]) * 0.9);
    expect(res.data.result.orderApprox).toBe(true);
    expect(res.data.result.legs).toHaveLength(24);
    expect(res.data.result.legs.every((l) => l.poly !== null)).toBe(true); // short legs stay within the shared budget

    resetRateLimits();
    h.input = TourInput.parse({ places: many.slice(0, 16) });
    h.matrix.mockResolvedValue({ durations: grid(16), snappedM: [], fetchedAt: "2026-11-01T00:00:00.000Z", stale: false, cache: "hit" });
    const exact = await computeTour(TOUR);
    expect(exact.ok && exact.data.result.orderApprox).toBeUndefined();
  });

  it("keep order: no matrix, overrides split runs (one request each), dropped overrides are counted", async () => {
    h.input = TourInput.parse({
      places: P.slice(0, 4),
      order: "keep",
      legOverrides: {
        [legKey("osm:w2", "osm:w3")]: { mode: "car", route: "no_highways" },
        [legKey("osm:w1", "osm:w4")]: { mode: "cycling", route: "quiet" }, // not neighbours in this order
      },
    });
    const res = await computeTour(TOUR);
    expect(h.gate).toHaveBeenCalledWith(3, { needsMatrix: false });
    expect(h.matrix).not.toHaveBeenCalled();
    expect(h.route).toHaveBeenCalledTimes(3);
    expect(h.route.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["foot-walking", "fastest"],
      ["driving-car", "no_highways"],
      ["foot-walking", "fastest"],
    ]);
    expect(res).toMatchObject({ ok: true, data: { droppedOverrides: 1 } });
    expect(res.ok && res.data.result.legs.map((l) => l.mode)).toEqual(["foot", "car", "foot"]);
  });

  it("unreachable pairs in the matrix flag the place; nothing is stored", async () => {
    const m = MATRIX.map((r, i) => r.map((v, j) => (i === 2 || j === 2) && i !== j ? null : v));
    h.matrix.mockResolvedValue({ durations: m, snappedM: [], fetchedAt: "f", stale: false, cache: "miss" });
    expect(await computeTour(TOUR)).toEqual({ ok: false, error: "unreachable", points: ["osm:w3"] });
    expect(h.route).not.toHaveBeenCalled();
    expect(adminWrites()).toHaveLength(0);
    expect(h.release).toHaveBeenCalledWith("slot1"); // nothing computed: the daily slot does not count
  });

  it("a place ORS cannot route (2010) is flagged too; nothing is stored", async () => {
    h.input = TourInput.parse({ places: P.slice(0, 3), order: "keep" });
    h.route.mockResolvedValue({ result: "not_routable", point: 1, fetchedAt: "f", stale: false, cache: "miss" });
    expect(await computeTour(TOUR)).toEqual({ ok: false, error: "unreachable", points: ["osm:w2"] });
    expect(adminWrites()).toHaveLength(0);
    expect(h.release).toHaveBeenCalledWith("slot1");
  });

  it("a failed run: its legs are failed, no total, no fit; never a guessed time", async () => {
    h.input = TourInput.parse({ places: P.slice(0, 3), order: "keep", maxMin: 60 });
    h.route.mockResolvedValue({ result: "failed" });
    const res = await computeTour(TOUR);
    expect(res.ok && res.data.result).toMatchObject({ totalMin: null, fit: "none" });
    expect(res.ok && res.data.result.legs.map((l) => [l.s, l.min, l.km, l.poly])).toEqual([
      ["failed", null, null, null],
      ["failed", null, null, null],
    ]);
    expect(h.logEvent.mock.calls[0][0].props).toMatchObject({ failedLegs: 2, cacheHits: 0 });
  });

  it("no route (2009) marks the run's legs no_route", async () => {
    h.input = TourInput.parse({ places: P.slice(0, 3), order: "keep" });
    h.route.mockResolvedValue({ result: "no_route", fetchedAt: "f", stale: false, cache: "hit" });
    const res = await computeTour(TOUR);
    expect(res.ok && res.data.result.legs.map((l) => l.s)).toEqual(["no_route", "no_route"]);
  });

  it("a stale cached value marks the result stale", async () => {
    h.matrix.mockResolvedValue({ durations: MATRIX, snappedM: [], fetchedAt: "f", stale: true, cache: "stale" });
    const res = await computeTour(TOUR);
    expect(res.ok && res.data.result.stale).toBe(true);
  });

  it("sights come from the cached city places of the city (general, Overpass cache-only), within the corridor", async () => {
    h.input = TourInput.parse({ city: { key: "geo:2761369", name: "Wien", lat: 48.20849, lon: 16.37208, source: "geonames" }, places: P.slice(0, 2), order: "keep" });
    h.route.mockResolvedValue(okRoute(2));
    const near = { key: "osm:n77", name: "Peterskirche", lat: 48.2087, lon: 16.3718, cat: "place_of_worship" };
    const far = { key: "osm:n78", name: "Schönbrunn", lat: 48.1845, lon: 16.3122, cat: "castle" };
    h.cityPlaces.mockResolvedValue({ places: [far, near, { ...P[0], cat: "x" }], pending: true, fetchedAt: "2026-11-02T00:00:00.000Z" });
    const res = await computeTour(TOUR);
    expect(h.cityPlaces.mock.calls[0][1]).toEqual(["general"]);
    expect(h.cityPlaces.mock.calls[0][0]).toMatchObject({ lat: 48.20849, lon: 16.37208, kind: "city" });
    expect(res.ok && res.data.result.sights.map((s) => s.key)).toEqual(["osm:n77"]);
    expect(res.ok && res.data).toMatchObject({ sightsPending: true });
    expect(res.ok && res.data.result.source).toEqual({ ors: "2026-11-12T10:00:00.000Z", osm: "2026-11-02T00:00:00.000Z" });
  });

  it("timing: stop times from the start time, over the limit with proposals, sunset in the city's zone", async () => {
    h.input = TourInput.parse({
      city: { key: "geo:2761369", name: "Wien", lat: 48.20849, lon: 16.37208, source: "geonames" },
      places: P.slice(0, 4),
      order: "keep",
      date: "2026-12-15",
      startTime: "14:00",
      maxMin: 120,
    });
    h.route.mockResolvedValue(okRoute(4));
    const res = await computeTour(TOUR);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const total = LEGS[0].min + LEGS[1].min + LEGS[2].min + 4 * 30;
    expect(res.data.result).toMatchObject({ totalMin: total, fit: "over" });
    expect(res.data.byMin).toBe(total - 120);
    expect(res.data.stopTimes?.[0]).toEqual({ arrive: "14:00", leave: "14:30" });
    expect(res.data.result.sunset).toMatch(/^16:0\d$/); // Wien, mid-December
    expect(h.getPlaceById).toHaveBeenCalledWith(2761369, "de");
    // keep order: no matrix fetched; proposals from a peeked (cache-only) matrix, here none → the dwell proposal only if it saves.
    expect(h.peek).toHaveBeenCalledTimes(1);
    expect(h.matrix).not.toHaveBeenCalled();
  });

  it("over the limit with the matrix at hand: drop proposals without extra calls", async () => {
    h.input = TourInput.parse({ places: P, maxMin: 120 });
    const res = await computeTour(TOUR);
    expect(res.ok && res.data.result.fit).toBe("over");
    expect(res.ok && res.data.proposals.length).toBeGreaterThan(0);
    expect(res.ok && res.data.proposals.every((p) => p.approx)).toBe(true);
    expect(h.peek).not.toHaveBeenCalled();
    expect(h.matrix).toHaveBeenCalledTimes(1);
  });

  it("the row changed meanwhile (0 rows updated) → conflict, nothing logged", async () => {
    const base = h.reply;
    h.reply = (o) => (o.client === "admin" ? { data: [] } : base(o));
    expect(await computeTour(TOUR)).toEqual({ ok: false, error: "conflict" });
    expect(h.logEvent).not.toHaveBeenCalled();
  });
});
