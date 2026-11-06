import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ group: vi.fn(), rest: vi.fn(), order: [] as string[] }));
vi.mock("./activities", () => ({ getActivityGroupFacts: h.group, getRestaurantFacts: h.rest }));

import type { Trip } from "@/lib/domain/trip";
import { getTripActivityFacts, loadActivityLookups } from "./activity-lookups";
import { PLACES_CACHE_ONLY } from "./places";

const ctx = { userId: "u", locale: "de" as const, today: "2026-11-06" };
const dest = { kind: "city", name: "Würzburg", placeName: "Würzburg", geoId: 1, countryCode: "DE", admin1: null, lat: 49.79, lon: 9.95, timezone: "Europe/Berlin", radiusKm: 15 } as const;
const ok = (data: unknown) => ({ status: "ok", data, source: "osm", sourceUrl: "u", fetchedAt: "f", stale: false });

beforeEach(() => {
  vi.clearAllMocks();
  h.order = [];
  h.rest.mockImplementation(async () => (h.order.push("restaurants"), ok({ radiusKm: 2.5, restaurants: [{ name: "R" }] })));
  h.group.mockImplementation(async (g: string) => (h.order.push(g), g === "outdoor" ? { status: "error", source: "osm" } : ok({ group: g, radiusKm: 15, places: [] })));
});

describe("loadActivityLookups", () => {
  it("restaurants first, then each group in order, mapped to compact lookups", async () => {
    const r = await loadActivityLookups(dest, { groups: ["indoor", "outdoor"] }, ctx, 60_000);
    expect(h.order).toEqual(["restaurants", "indoor", "outdoor"]);
    expect(r.restaurants).toEqual({ status: "ok", restaurants: [{ name: "R" }], radiusKm: 2.5, fetchedAt: "f" });
    expect(r.activities).toEqual([
      { group: "indoor", status: "ok", places: [], fetchedAt: "f" },
      { group: "outdoor", status: "error", places: [] },
    ]);
  });

  it("shares one budget; cache only stays cache only; restaurants can be skipped or loaded near a point", async () => {
    await loadActivityLookups(dest, { groups: ["indoor"], restaurants: { near: { lat: 1, lon: 2 } } }, ctx, PLACES_CACHE_ONLY);
    expect(h.rest).toHaveBeenCalledWith(dest, ctx, { budgetMs: PLACES_CACHE_ONLY, near: { lat: 1, lon: 2 } });
    expect(h.group.mock.calls[0][3]).toEqual({ budgetMs: PLACES_CACHE_ONLY });
    h.rest.mockClear();
    const r = await loadActivityLookups(dest, { groups: [], restaurants: false }, ctx, 1000);
    expect(h.rest).not.toHaveBeenCalled();
    expect(r).toEqual({ activities: [] });
  });

  it("each lookup gets what is left of the shared window (decreasing budgetMs), never below cache only", async () => {
    let t = 1_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => t);
    h.rest.mockImplementation(async () => ((t += 20_000), ok({ radiusKm: 2.5, restaurants: [], truncated: false })));
    h.group.mockImplementation(async () => ((t += 30_000), ok({ group: "indoor", radiusKm: 15, places: [], truncated: false })));
    await loadActivityLookups(dest, { groups: ["indoor", "outdoor", "going_out"] }, ctx, 60_000);
    now.mockRestore();
    expect(h.rest.mock.calls[0][2]).toMatchObject({ budgetMs: 60_000 });
    expect(h.group.mock.calls.map((c) => (c[3] as { budgetMs: number }).budgetMs)).toEqual([40_000, 10_000, PLACES_CACHE_ONLY]);
  });

  it("keeps the skip reason and the truncated flag", async () => {
    h.rest.mockResolvedValueOnce({ status: "skipped", reason: "cache_only" });
    h.group.mockResolvedValueOnce(ok({ group: "indoor", radiusKm: 15, places: [], truncated: true }));
    const r = await loadActivityLookups(dest, { groups: ["indoor"] }, ctx, 1000);
    expect(r.restaurants).toEqual({ status: "skipped", restaurants: [], reason: "cache_only" });
    expect(r.activities[0]).toMatchObject({ status: "ok", truncated: true });
  });

  it("a throwing lookup counts as error", async () => {
    h.rest.mockRejectedValueOnce(new Error("x"));
    expect((await loadActivityLookups(dest, { groups: [] }, ctx, 1000)).restaurants).toEqual({ status: "error", restaurants: [] });
  });
});

describe("getTripActivityFacts", () => {
  const trip = { destination: dest } as unknown as Trip;
  it("loads the groups the purpose wishes need, and restaurants always", async () => {
    const tags = { v: 2, interests: [], custom: [], hard: [], soft: [], summary: "", activities: [{ types: ["escape_game"], open: true }, { types: [], open: true, group: "outdoor" }] };
    const r = await getTripActivityFacts(trip, { tags } as never, ctx, 1000);
    expect(h.order).toEqual(["restaurants", "indoor", "outdoor"]);
    expect(r.activities).toHaveLength(2);
  });
  it("without wishes: restaurants only, no activities key", async () => {
    const r = await getTripActivityFacts(trip, null, ctx, 1000);
    expect(r.activities).toBeUndefined();
    expect(r.restaurants?.status).toBe("ok");
  });
});
