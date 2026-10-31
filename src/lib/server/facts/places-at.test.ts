import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
type Opts = { provider: string; key: string; fetchAllowed?: () => boolean; fetcher: () => Promise<unknown> };
const state = vi.hoisted(() => ({ calls: [] as Opts[], impl: ((): unknown => undefined) as (o: Opts) => unknown }));
vi.mock("../api-cache", () => ({
  cached: (o: Opts) => { state.calls.push(o); return Promise.resolve(state.impl(o)); },
  cacheKey: (e: string, v: number, p: Record<string, string | number>) => `${e}:v${v}:${JSON.stringify(p)}`,
}));
vi.mock("./geoapify-quota", () => ({ assertGeoapifyQuota: async () => {} }));

import { getPlacesAt, getPlacesFacts } from "./places";

const ctx = { userId: "u1", locale: "de" as const, today: "2026-11-01" };
const ok = (cache: string, n = 1) => ({ ok: true, data: Array.from({ length: n }, () => ({})), fetchedAt: "2026-11-01T00:00:00.000Z", stale: false, cache });
const fail = { ok: false, error: "timeout" };
const point = { lat: 36.5101, lon: -4.8824 };

describe("getPlacesAt (destination search lookup by coordinates)", () => {
  beforeEach(() => {
    state.calls = [];
    vi.stubEnv("GEOAPIFY_API_KEY", "test-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("shares its cache keys with getPlacesFacts: a trip made from the card finds the lookup cached", async () => {
    state.impl = () => ok("miss");
    await getPlacesAt("golf", point, 40, ctx, { networkAllowed: true });
    const searchKeys = state.calls.map((c) => c.key);
    state.calls = [];
    const trip = {
      id: "t", lengthDays: 7, groupId: null, purposeId: "p", wantsFlights: false, originAirports: [], createdAt: "", updatedAt: "",
      timing: { kind: "none" as const },
      destination: { kind: "region" as const, name: "Costa del Sol", placeName: "Marbella", geoId: 1, countryCode: "ES", admin1: null, lat: point.lat, lon: point.lon, timezone: "Europe/Madrid", radiusKm: 40 },
    };
    const purpose = { id: "p", name: "p", guided: { interests: ["golf"] }, constraints: [], tags: null, createdAt: "", updatedAt: "" };
    await getPlacesFacts(trip as never, purpose as never, ctx);
    expect(state.calls.map((c) => c.key)).toEqual(searchKeys);
  });

  it("the radius comes from radiusForInterest: golf has a minimum of 40 km even for a city base", async () => {
    state.impl = () => ok("miss");
    const r = await getPlacesAt("golf", point, 15, ctx, { networkAllowed: true });
    expect(r?.radiusKm).toBe(40);
    expect((await getPlacesAt("museums", point, 15, ctx, { networkAllowed: true }))?.radiusKm).toBe(15);
  });

  it("cache first, then Geoapify; Overpass is never queried over the network", async () => {
    state.impl = (o) => (o.provider === "overpass" ? fail : ok("miss", 3));
    const r = await getPlacesAt("golf", point, 40, ctx, { networkAllowed: true });
    expect(r?.result).toMatchObject({ ok: true });
    expect(state.calls.map((c) => c.provider)).toEqual(["overpass", "geoapify"]);
    expect(state.calls[0].fetchAllowed?.()).toBe(false);
  });

  it("an interest with no Geoapify mapping (skiing) is read from the Overpass cache only", async () => {
    state.impl = () => fail;
    const r = await getPlacesAt("skiing", point, 15, ctx, { networkAllowed: false });
    expect(r?.result).toMatchObject({ ok: false });
    expect(state.calls.map((c) => c.provider)).toEqual(["overpass"]);
    expect(state.calls.every((c) => c.fetchAllowed?.() === false)).toBe(true);
  });

  it("no Geoapify key: only the Overpass cache is read", async () => {
    vi.stubEnv("GEOAPIFY_API_KEY", "");
    state.impl = (o) => (o.provider === "overpass" ? ok("hit", 2) : fail);
    const r = await getPlacesAt("golf", point, 40, ctx, { networkAllowed: true });
    expect(r?.result).toMatchObject({ ok: true });
    expect(state.calls.every((c) => c.provider === "overpass")).toBe(true);
  });

  it("networkAllowed false: Geoapify is read from its cache only", async () => {
    state.impl = (o) => (o.provider === "overpass" ? fail : fail);
    await getPlacesAt("golf", point, 40, ctx, { networkAllowed: false });
    const geo = state.calls.find((c) => c.provider === "geoapify");
    expect(geo?.fetchAllowed?.()).toBe(false);
  });

  it("an interest without any source gives null", async () => {
    state.impl = () => ok("miss");
    expect(await getPlacesAt("cruise", point, 15, ctx, { networkAllowed: true })).toBeNull();
    expect(state.calls).toEqual([]);
  });
});
