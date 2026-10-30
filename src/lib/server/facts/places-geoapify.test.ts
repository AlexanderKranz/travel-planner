import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
type Opts = { provider: string; key: string; fetchAllowed?: () => boolean; fetcher: () => Promise<unknown> };
const state = vi.hoisted(() => ({ calls: [] as Opts[], impl: ((): unknown => undefined) as (o: Opts) => unknown }));
vi.mock("../api-cache", () => ({
  cached: (o: Opts) => { state.calls.push(o); return state.impl(o); },
  cacheKey: (e: string, v: number, p: Record<string, string | number>) => `${e}:v${v}:${JSON.stringify(p)}`,
}));
vi.mock("./geoapify-quota", () => ({ assertGeoapifyQuota: async () => {} }));

import { getPlacesFacts } from "./places";

const ctx = { userId: null, locale: "de" as const, today: "2026-10-30" };
const trip = {
  id: "t", lengthDays: 5, groupId: null, purposeId: "p", wantsFlights: false, originAirports: [], createdAt: "", updatedAt: "",
  timing: { kind: "none" as const },
  destination: { kind: "city" as const, name: "Passau", placeName: "Passau", geoId: 1, countryCode: "DE", admin1: null, lat: 48.5665, lon: 13.4312, timezone: "Europe/Berlin", radiusKm: 15 },
};
const purpose = (interests: string[]) => ({ id: "p", name: "p", guided: { interests }, constraints: [], tags: null, createdAt: "", updatedAt: "" });
const ok = (cache: string) => ({ ok: true, data: [], fetchedAt: "2026-10-30T00:00:00.000Z", stale: false, cache });
const run = (interests: string[]) => getPlacesFacts(trip as never, purpose(interests) as never, ctx);
/** Sequence of (provider, network allowed?) per cached() call. */
const trace = () => state.calls.map((c) => `${c.provider}:${c.fetchAllowed?.() === false ? "cache-only" : "net"}`);

describe("places: Geoapify first, Overpass as fallback", () => {
  beforeEach(() => {
    state.calls = [];
    vi.stubEnv("GEOAPIFY_API_KEY", "test-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("an Overpass result already in the cache wins (no Geoapify call)", async () => {
    state.impl = (o) => (o.provider === "overpass" ? ok("hit") : ok("miss"));
    await run(["wellness"]);
    expect(state.calls.map((c) => c.provider)).toEqual(["overpass"]);
  });

  it("no cached Overpass result: Geoapify answers, Overpass is not queried over the network", async () => {
    state.impl = (o) => (o.provider === "overpass" ? { ok: false, error: "timeout" } : ok("miss"));
    await run(["wellness"]);
    expect(state.calls.map((c) => c.provider)).toEqual(["overpass", "geoapify"]);
    expect(state.calls[1].key).toContain("places:v2");
  });

  it("Geoapify fails (quota, 5xx, timeout): Overpass over the network", async () => {
    state.impl = (o) => (o.provider === "geoapify" ? { ok: false, error: "provider_error" } : state.calls.length === 1 ? { ok: false, error: "timeout" } : ok("miss"));
    await run(["wellness"]);
    expect(state.calls.map((c) => c.provider)).toEqual(["overpass", "geoapify", "overpass"]);
    expect(trace()[0]).toBe("overpass:cache-only");
  });

  it("Geoapify runs for all interests before any Overpass network query (which stays sequential)", async () => {
    state.impl = (o) => (o.provider === "geoapify" && o.key.includes("golf") ? { ok: false, error: "provider_error" } : o.provider === "overpass" && o.fetchAllowed?.() !== false ? ok("miss") : o.provider === "overpass" ? { ok: false, error: "timeout" } : ok("miss"));
    await run(["wellness", "golf"]);
    expect(trace()).toEqual(["overpass:cache-only", "overpass:cache-only", "geoapify:net", "geoapify:net", "overpass:net"]);
  });

  it("interests without a Geoapify mapping and a missing key go straight to Overpass", async () => {
    state.impl = () => ok("miss");
    await run(["architecture"]);
    expect(state.calls.map((c) => c.provider)).toEqual(["overpass"]);
    state.calls = [];
    vi.stubEnv("GEOAPIFY_API_KEY", "");
    await run(["wellness"]);
    expect(state.calls.map((c) => c.provider)).toEqual(["overpass"]);
  });
});
