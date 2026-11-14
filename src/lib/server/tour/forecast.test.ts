import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { Op, Reply } from "./test-db";

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  reply: (() => ({})) as (op: Op) => Reply,
  cached: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock("../session", async () => {
  const { fakeDb } = await import("./test-db");
  return { getUserSession: async () => ({ userId: "u1", supabase: fakeDb("user", h.ops, (o) => h.reply(o)) }) };
});
vi.mock("../api-cache", async (orig) => ({ ...(await orig<typeof import("../api-cache")>()), cached: h.cached }));
vi.mock("../events", () => ({ logEvent: h.logEvent }));

import { TourInput } from "@/lib/domain/tour";
import { resetRateLimits } from "../rate-limit";
import { getTourForecast } from "./forecast";

const TOUR = "44444444-4444-4444-8444-444444444444";
const DATE = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
const places = [
  { key: "osm:w1", name: "A", lat: 48.2085, lon: 16.3731, source: "osm" as const },
  { key: "osm:w2", name: "B", lat: 48.2065, lon: 16.3655, source: "osm" as const },
];
const row = (date: string) => ({
  id: TOUR, owner_id: "u1", title: null, input: TourInput.parse({ places, date }), trip_id: null, trip_day: null,
  result: null, result_hash: null, computed_at: null, created_at: "2026-11-12T00:00:00Z", updated_at: "2026-11-12T00:00:00Z",
});
const day = { date: DATE, code: 61, tMax: 8, tMin: 4, precipMm: 2, precipProb: 60 };

beforeEach(() => {
  resetRateLimits();
  h.ops = [];
  h.reply = (o) => (o.table === "city_tours" ? { data: row(DATE) } : {});
  h.cached.mockReset().mockResolvedValue({ ok: true, data: day, fetchedAt: "2026-11-14T01:00:00.000Z", stale: false, cache: "miss" });
  h.logEvent.mockReset();
});

describe("getTourForecast", () => {
  it("returns the forecast for the displayed date", async () => {
    expect(await getTourForecast(TOUR, DATE)).toMatchObject({ date: DATE, code: 61, fetchedAt: "2026-11-14T01:00:00.000Z" });
  });

  it("no forecast when the saved date differs from the displayed one (changed in another tab)", async () => {
    h.reply = (o) => (o.table === "city_tours" ? { data: row("2030-01-01") } : {});
    expect(await getTourForecast(TOUR, DATE)).toBeNull();
    expect(h.cached).not.toHaveBeenCalled();
  });

  it("an expired row served after a failed refresh is not shown", async () => {
    h.cached.mockResolvedValue({ ok: true, data: day, fetchedAt: "2026-11-01T00:00:00.000Z", stale: true, cache: "stale" });
    expect(await getTourForecast(TOUR, DATE)).toBeNull();
  });

  it("a failed read is logged, not mistaken for a tour without a date", async () => {
    h.reply = (o) => (o.table === "city_tours" ? { error: { code: "42501" } } : {});
    expect(await getTourForecast(TOUR, DATE)).toBeNull();
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "tour.forecast_failed", level: "error" }));
  });
});
