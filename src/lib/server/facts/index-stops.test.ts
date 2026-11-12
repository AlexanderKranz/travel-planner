import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  order: [] as string[],
  getStopFacts: vi.fn(),
  resolveStops: vi.fn(),
  enqueue: vi.fn(async () => {}),
  fact: (name: string) => async () => (h.order.push(name), { status: "unavailable", reason: "no_location" }),
}));

vi.mock("./weather", () => ({ getWeatherFacts: h.fact("weather") }));
vi.mock("./daylight", () => ({ getDaylightFacts: h.fact("daylight") }));
vi.mock("./country", () => ({ getCountryFacts: h.fact("country") }));
vi.mock("./summary", () => ({ getSummaryFacts: h.fact("summary") }));
vi.mock("./flights", () => ({ getFlightsFacts: h.fact("flights") }));
vi.mock("./picture", () => ({ getDestinationPicture: async () => undefined, getSharedDestinationPicture: async () => undefined }));
vi.mock("./places", () => ({ getPlacesFacts: h.fact("places") }));
vi.mock("./activity-lookups", () => ({ getTripActivityFacts: async () => (h.order.push("activities"), {}) }));
vi.mock("./stops", () => ({ getStopFacts: h.getStopFacts }));
vi.mock("../trip-stops", () => ({ resolveTripStops: h.resolveStops }));
vi.mock("../place-retries", () => ({ enqueuePlaceRetries: h.enqueue }));

import type { Trip } from "@/lib/domain/trip";
import { getTripFacts, warmTripFacts } from "./index";

const ctx = { userId: "u1", locale: "de" as const, today: "2026-11-11" };
const trip = {
  id: "t1", ownerId: "u1", access: "owner", lengthDays: 5, groupId: null, purposeId: null, wantsFlights: false, originAirports: [], createdAt: "", updatedAt: "",
  timing: { kind: "none" },
  destination: { kind: "city", name: "Passau", placeName: "Passau", geoId: 1, countryCode: "DE", admin1: null, lat: 48.5, lon: 13.4, timezone: null, radiusKm: 15 },
} as unknown as Trip;
const STOPS = [{ day: 2, place: "Wien" }];
const stopFacts = [{ stop: { id: "s1", name: "Wien", days: [2], role: "stop", point: { lat: 48.2, lon: 16.37, geoId: 2 }, status: "ok" }, places: [{ interest: "general", status: "error" }], restaurants: { status: "error", restaurants: [] } }];

beforeEach(() => {
  vi.clearAllMocks();
  h.order = [];
  h.getStopFacts.mockImplementation(async () => (h.order.push("stops"), stopFacts));
  h.resolveStops.mockResolvedValue([]);
});

describe("getTripFacts with stops", () => {
  it("[P7] inline: the stops are looked up beside the destination, cache and Geoapify only, within the same budget", async () => {
    const f = await getTripFacts(trip, null, ctx, { placesBudgetMs: 110_000, stops: STOPS });
    expect(f.stops).toEqual(stopFacts);
    expect(h.getStopFacts).toHaveBeenCalledWith(trip, STOPS, null, ctx, { budgetMs: 110_000, overpass: "cache_only" });
  });

  it("without stops there is no stops key and no lookup", async () => {
    const f = await getTripFacts(trip, null, ctx, { placesBudgetMs: 110_000 });
    expect(f).not.toHaveProperty("stops");
    expect(h.getStopFacts).not.toHaveBeenCalled();
  });

  it("a failing stop lookup never fails the facts", async () => {
    h.getStopFacts.mockRejectedValue(new Error("x"));
    const f = await getTripFacts(trip, null, ctx, { placesBudgetMs: 110_000, stops: STOPS });
    expect(f).not.toHaveProperty("stops");
  });

  it("cache-only runs ('generate anyway') pass a zero budget through", async () => {
    await getTripFacts(trip, null, ctx, { placesBudgetMs: 0, stops: STOPS });
    expect(h.getStopFacts.mock.calls[0][4]).toEqual({ budgetMs: 0, overpass: "cache_only" });
  });
});

describe("warmTripFacts with stops", () => {
  it("[P7] the warm-up resolves the stops, looks them up AFTER the destination with Overpass allowed, and queues their failures", async () => {
    h.resolveStops.mockResolvedValue(STOPS);
    await warmTripFacts(trip, null, ctx, { budgetMs: 200_000 });
    expect(h.resolveStops).toHaveBeenCalledWith(trip, undefined);
    expect(h.order.indexOf("stops")).toBeGreaterThan(h.order.indexOf("activities"));
    expect(h.order.indexOf("stops")).toBeGreaterThan(h.order.indexOf("places"));
    const opts = h.getStopFacts.mock.calls[0][4] as { budgetMs: number; overpass: string };
    expect(opts.overpass).toBe("allowed");
    expect(opts.budgetMs).toBeGreaterThan(0);
    expect(opts.budgetMs).toBeLessThanOrEqual(200_000);
    const jobs = (h.enqueue.mock.calls as unknown as { kind: string }[][][]).flatMap((c) => c[0]);
    expect(jobs.map((j) => j.kind).sort()).toEqual(["interest", "restaurants"]);
  });

  it("no stops: no stop lookups at all", async () => {
    await warmTripFacts(trip, null, ctx, { budgetMs: 200_000 });
    expect(h.getStopFacts).not.toHaveBeenCalled();
  });
});
