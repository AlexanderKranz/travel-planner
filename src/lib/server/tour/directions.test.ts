import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { Op, Reply } from "./test-db";

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  reply: (() => ({})) as (op: Op) => Reply,
  row: null as Record<string, unknown> | null,
  gate: vi.fn(async () => true),
  steps: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock("../session", async () => {
  const { fakeDb } = await import("./test-db");
  return { getUserSession: async () => ({ userId: "viewer", supabase: fakeDb("user", h.ops, (o) => h.reply(o)) }) };
});
vi.mock("../facts/ors-quota", () => ({ orsTourGate: h.gate }));
vi.mock("../facts/tour-ors", () => ({ getTourSteps: h.steps }));
vi.mock("../events", () => ({ logEvent: h.logEvent }));

import { legKey, TourInput, type TourResult } from "@/lib/domain/tour";
import { tourInputHash } from "@/lib/tour/hash";
import { encodePolyline } from "@/lib/tour/polyline";
import { resetRateLimits } from "../rate-limit";
import { resultVersion } from "@/lib/tour/steps";
import { getTourDirections } from "./directions";

/** Version of the stored result (what the page rendered). */
const V = () => (h.row?.result ? resultVersion(h.row.result as TourResult) : "none");
const TOUR = "22222222-2222-4222-8222-222222222222";
const P = [
  { key: "osm:w1", name: "Stephansdom", lat: 48.2085, lon: 16.3731, source: "osm" as const },
  { key: "osm:w2", name: "Hofburg", lat: 48.2065, lon: 16.3655, source: "osm" as const },
  { key: "osm:w3", name: "Naschmarkt", lat: 48.199, lon: 16.363, source: "osm" as const },
];
const LINE = encodePolyline([[48.2085, 16.3731], [48.2065, 16.3655]]);
const leg = (from: string, to: string, mode: "foot" | "car", km: number) => ({ from, to, mode, route: mode === "car" ? "no_highways" : "fastest", min: 10, km, poly: LINE, s: "ok" }) as const;

function setup(opts: { overrides?: boolean; hash?: string | null; result?: TourResult | null } = {}) {
  const input = TourInput.parse({
    places: P,
    order: "keep",
    ...(opts.overrides ? { legOverrides: { [legKey("osm:w2", "osm:w3")]: { mode: "car", route: "no_highways" } } } : {}),
  });
  const result: TourResult = {
    v: 1,
    order: P.map((p) => p.key),
    legs: [leg("osm:w1", "osm:w2", "foot", 0.6), leg("osm:w2", "osm:w3", opts.overrides ? "car" : "foot", 1.0)],
    totalMin: 80,
    fit: "none",
    sights: [],
    source: { ors: "2026-11-12T10:00:00.000Z" },
  };
  h.row = {
    id: TOUR, owner_id: "owner", title: null, input, trip_id: null, trip_day: null,
    result: opts.result === undefined ? result : opts.result,
    result_hash: opts.hash === undefined ? tourInputHash(input) : opts.hash,
    computed_at: "2026-11-12T10:00:00Z", created_at: "2026-11-12T00:00:00Z", updated_at: "2026-11-12T00:00:00Z",
  };
}
const ok = (legs: { km: number }[]) => ({
  result: "ok",
  legs: legs.map((l) => ({ min: 10, km: l.km, poly: LINE, steps: [[11, "", 10, 0], [10, "", 0, 3]] })),
  fetchedAt: "2026-11-13T09:00:00.000Z",
  stale: false,
  cache: "miss",
});

beforeEach(() => {
  resetRateLimits();
  h.ops = [];
  h.reply = (o) => (o.table === "city_tours" ? { data: h.row } : {});
  h.gate.mockReset().mockResolvedValue(true);
  h.steps.mockReset();
  h.logEvent.mockReset();
  setup();
});

describe("getTourDirections", () => {
  it("one steps request per run of the stored result (any reader), per-leg steps, changed legs flagged", async () => {
    setup({ overrides: true });
    h.steps.mockResolvedValueOnce(ok([{ km: 0.6 }])).mockResolvedValueOnce(ok([{ km: 1.2 }]));
    const res = await getTourDirections(TOUR, V());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.gate).toHaveBeenCalledWith(2, { needsMatrix: false });
    expect(h.steps.mock.calls.map((c) => [c[0], c[1], c[2].map((p: { key: string }) => p.key)])).toEqual([
      ["foot-walking", "fastest", ["osm:w1", "osm:w2"]],
      ["driving-car", "no_highways", ["osm:w2", "osm:w3"]],
    ]);
    expect(res.data.legs.map((l) => l?.changed)).toEqual([false, true]);
    expect(res.data.legs[0]?.steps).toEqual([[11, "", 10, 0], [10, "", 0, 3]]);
    expect(res.data.fetchedAt).toBe("2026-11-13T09:00:00.000Z");
    expect(h.ops.filter((o) => o.op !== "select")).toHaveLength(0); // nothing written to the tour
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "tour.directions", props: expect.objectContaining({ runs: 2, failedLegs: 0 }) }));
  });

  it("a failed run leaves its legs null; all failed → ors_unavailable", async () => {
    setup({ overrides: true });
    h.steps.mockResolvedValueOnce(ok([{ km: 0.6 }])).mockResolvedValueOnce({ result: "failed" });
    const res = await getTourDirections(TOUR, V());
    expect(res.ok && res.data.legs.map((l) => l === null)).toEqual([false, true]);
    h.steps.mockResolvedValue({ result: "failed" });
    expect(await getTourDirections(TOUR, V())).toEqual({ ok: false, error: "ors_unavailable" });
  });

  it("no result or an outdated one → not_computed, no ORS call", async () => {
    setup({ result: null, hash: null });
    expect(await getTourDirections(TOUR, V())).toEqual({ ok: false, error: "not_computed" });
    setup({ hash: "0".repeat(64) });
    expect(await getTourDirections(TOUR, V())).toEqual({ ok: false, error: "not_computed" });
    expect(h.steps).not.toHaveBeenCalled();
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("gate closed → ors_unavailable; bad id → invalid; missing row → not_found", async () => {
    h.gate.mockResolvedValue(false);
    expect(await getTourDirections(TOUR, V())).toEqual({ ok: false, error: "ors_unavailable" });
    expect(await getTourDirections("nope", "x")).toEqual({ ok: false, error: "invalid" });
    h.row = null;
    expect(await getTourDirections(TOUR, V())).toEqual({ ok: false, error: "not_found" });
    expect(h.steps).not.toHaveBeenCalled();
  });

  it("refuses an answer for another version of the result (edited or recomputed elsewhere)", async () => {
    expect(await getTourDirections(TOUR, "stale-version")).toEqual({ ok: false, error: "conflict" });
    expect(h.steps).not.toHaveBeenCalled();
  });

  it("steps cached before the last computation are fetched again (refresh)", async () => {
    h.steps.mockResolvedValueOnce({ ...ok([{ km: 0.6 }, { km: 1.0 }]), fetchedAt: "2026-11-01T00:00:00.000Z", cache: "hit" }).mockResolvedValueOnce(ok([{ km: 0.6 }, { km: 1.0 }]));
    const res = await getTourDirections(TOUR, V());
    expect(res.ok).toBe(true);
    expect(h.steps).toHaveBeenCalledTimes(2);
    expect(h.steps.mock.calls[1][4]).toEqual({ refresh: true });
  });

  it("rate limited after 6 per minute", async () => {
    h.steps.mockResolvedValue(ok([{ km: 0.6 }, { km: 1.0 }]));
    for (let i = 0; i < 6; i++) expect((await getTourDirections(TOUR, V())).ok).toBe(true);
    expect(await getTourDirections(TOUR, V())).toMatchObject({ ok: false, error: "rate_limited" });
  });
});
