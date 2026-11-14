import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  calls: [] as Record<string, unknown>[],
  peeks: [] as string[],
  buckets: [] as string[],
  quotaOk: true,
  postJson: vi.fn(),
}));
/** In-memory api_cache like the real one: a hit never calls the fetcher; failures are not stored. */
vi.mock("../api-cache", async (orig) => {
  const m = await orig<typeof import("../api-cache")>();
  return {
    ...m,
    peekCache: async (o: { key: string; schema: { parse: (v: unknown) => unknown } }) => {
      h.peeks.push(o.key);
      return h.store.has(o.key) ? { data: o.schema.parse(h.store.get(o.key)), fetchedAt: "f0" } : undefined;
    },
    cached: async (o: { key: string; schema: { parse: (v: unknown) => unknown }; fetcher: () => Promise<{ data: unknown }> }) => {
      h.calls.push(o);
      if (h.store.has(o.key)) return { ok: true, data: h.store.get(o.key), fetchedAt: "f0", stale: false, cache: "hit" };
      try {
        const data = o.schema.parse((await o.fetcher()).data);
        h.store.set(o.key, data);
        return { ok: true, data, fetchedAt: "f1", stale: false, cache: "miss" };
      } catch {
        return { ok: false, error: "provider_error" };
      }
    },
  };
});
vi.mock("./ors-quota", () => ({
  assertOrsQuota: async (bucket: string) => {
    h.buckets.push(bucket);
    if (!h.quotaOk) throw Object.assign(new Error("cap"), { name: "QuotaGuardError" });
  },
}));
vi.mock("@/lib/integrations/http", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/http")>()), postJson: h.postJson }));

import { HttpError } from "@/lib/integrations/http";
import {
  getTourMatrix,
  getTourRoute,
  getTourSteps,
  peekTourMatrix,
  TOUR_ORS_TTL_SECONDS,
  tourMatrixKey,
  tourRouteKey,
  tourStepsKey,
  withinPolyBudget,
  withinStepsBudget,
} from "./tour-ors";
import type { OrsStep } from "@/lib/integrations/openrouteservice";

describe("withinStepsBudget (steps entries stay under the cache row limit)", () => {
  const step = (i: number): OrsStep => [1, `Straße ${i}`, 50, i];
  const leg = (poly: number, steps: number) => ({ min: 5, km: 1, poly: "a".repeat(poly), steps: Array.from({ length: steps }, (_, i) => step(i)) });

  it("keeps a normal entry as it is", () => {
    const r = withinStepsBudget({ result: "ok", legs: [leg(500, 20), leg(800, 30)] });
    expect(r.result === "ok" && r.legs.map((l) => [l.poly.length, l.steps.length])).toEqual([[500, 20], [800, 30]]);
  });

  it("cuts steps per leg (arrival kept), drops the longest lines first and fits the budget", () => {
    const big = withinStepsBudget({ result: "ok", legs: Array.from({ length: 26 }, (_, i) => leg(i === 0 ? 7000 : 7600, 500)) });
    if (big.result !== "ok") throw new Error("unexpected");
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(250_000);
    expect(big.legs.every((l) => l.steps.length <= 400)).toBe(true);
    expect(big.legs[1].steps.at(-1)).toEqual(step(499));
    expect(big.legs.some((l) => l.poly === "")).toBe(true);
    expect(withinStepsBudget({ result: "no_route" })).toEqual({ result: "no_route" });
  });
});

const fx = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../integrations/__fixtures__/ors-tour", `${name}.json`), "utf8"));
const wien = [
  { key: "osm:w212496461", lat: 48.2085, lon: 16.3731 },
  { key: "osm:w1", lat: 48.2065, lon: 16.3655 },
  { key: "osm:w2", lat: 48.199, lon: 16.363 },
  { key: "osm:w3", lat: 48.1981, lon: 16.3716 },
  { key: "osm:w4", lat: 48.1915, lon: 16.381 },
  { key: "osm:w5", lat: 48.2166, lon: 16.3958 },
];
const ctx = { userId: "u1" };

beforeEach(() => {
  h.store.clear();
  h.calls.length = 0;
  h.peeks.length = 0;
  h.buckets.length = 0;
  h.quotaOk = true;
  h.postJson.mockReset();
  vi.stubEnv("OPENROUTESERVICE_API_KEY", "k");
});
afterEach(() => vi.unstubAllEnvs());

describe("cache keys (spec 11)", () => {
  it("tour-matrix: profile + hash of the sorted points, independent of order", () => {
    const k = tourMatrixKey("foot-walking", wien);
    expect(k).toMatch(/^tour-matrix:v1:h=[0-9a-f]{32};profile=foot-walking$/);
    expect(tourMatrixKey("foot-walking", [...wien].reverse())).toBe(k);
    expect(tourMatrixKey("wheelchair", wien)).not.toBe(k);
    expect(tourMatrixKey("foot-walking", [{ ...wien[0], lat: 48.20851 }, ...wien.slice(1)])).not.toBe(k);
  });
  it("tour-route: profile + option + hash of the ordered points", () => {
    const k = tourRouteKey("foot-walking", "green", wien);
    expect(k).toMatch(/^tour-route:v1:h=[0-9a-f]{32};profile=foot-walking;route=green$/);
    expect(tourRouteKey("foot-walking", "green", [...wien].reverse())).not.toBe(k);
    expect(tourRouteKey("foot-walking", "quiet", wien)).not.toBe(k);
  });
});

describe("getTourMatrix", () => {
  it("one request in canonical order, logged as tour_matrix for 90 days, matrix bucket; re-indexed to the caller's order", async () => {
    // Answers with the recorded matrix permuted to whatever (canonical) order the client sends.
    h.postJson.mockImplementation(async (_url: string, body: { locations: number[][] }) => {
      const spike = fx("matrix-foot-wien");
      const order = body.locations.map(([lon, lat]) => wien.findIndex((p) => p.lon === lon && p.lat === lat));
      return {
        status: 200,
        latencyMs: 1,
        body: { ...spike, durations: order.map((i) => order.map((j) => spike.durations[i][j])), sources: order.map((i) => spike.sources[i]) },
      };
    });
    const m = await getTourMatrix("foot-walking", wien, ctx);
    expect(h.calls[0]).toMatchObject({ provider: "openrouteservice", endpoint: "tour_matrix", ttlSeconds: TOUR_ORS_TTL_SECONDS });
    expect(TOUR_ORS_TTL_SECONDS).toBe(90 * 86400);
    expect(h.buckets).toEqual(["matrix"]);
    expect(m?.durations[0][1]).toBe(551.46); // Stephansdom → Hofburg, in the caller's order
    expect(m?.durations[4][5]).toBe(2560.1);
    expect(m?.snappedM[3]).toBe(9.62);

    // Another order of the same points: a cache hit, re-indexed, no second request.
    const reversed = [...wien].reverse();
    const r = await getTourMatrix("foot-walking", reversed, ctx);
    expect(h.postJson).toHaveBeenCalledTimes(1);
    expect(r?.durations[5][4]).toBe(551.46);
    expect(r?.fetchedAt).toBe("f0");
  });

  it("reports how the cache answered; peekTourMatrix reads the cache only (no request, no quota check)", async () => {
    h.postJson.mockResolvedValue({ status: 200, latencyMs: 1, body: { durations: [[0, 60], [70, 0]] } });
    expect(await peekTourMatrix("foot-walking", wien.slice(0, 2))).toBeNull();
    expect((await getTourMatrix("foot-walking", wien.slice(0, 2), ctx))?.cache).toBe("miss");
    expect((await getTourMatrix("foot-walking", wien.slice(0, 2), ctx))?.cache).toBe("hit");
    h.buckets.length = 0;
    const peeked = await peekTourMatrix("foot-walking", [wien[0], wien[1]]); // canonical order is [w1, w212496461]
    expect(peeked?.durations).toEqual([[0, 70], [60, 0]]);
    expect(h.peeks).toEqual([tourMatrixKey("foot-walking", wien.slice(0, 2)), tourMatrixKey("foot-walking", wien.slice(0, 2))]);
    expect(h.postJson).toHaveBeenCalledTimes(1);
    expect(h.buckets).toEqual([]);
  });

  it("start = end (a round trip) shares one row", async () => {
    h.postJson.mockResolvedValue({ status: 200, latencyMs: 1, body: { durations: [[0, 60], [70, 0]] } });
    const m = await getTourMatrix("foot-walking", [wien[0], wien[1], wien[0]], ctx);
    const body = h.postJson.mock.calls[0][1] as { locations: unknown[] };
    expect(body.locations).toHaveLength(2);
    expect(m?.durations).toHaveLength(3);
    expect(m?.durations[0][2]).toBe(0);
    expect(m?.durations[1][2]).toBe(m?.durations[1][0]);
  });

  it("failure, quota or no key → null, nothing cached", async () => {
    h.postJson.mockRejectedValue(new HttpError(503));
    expect(await getTourMatrix("foot-walking", wien, ctx)).toBeNull();
    h.quotaOk = false;
    expect(await getTourMatrix("foot-walking", wien, ctx)).toBeNull();
    expect(h.postJson).toHaveBeenCalledTimes(1);
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "");
    expect(await getTourMatrix("foot-walking", wien, ctx)).toBeNull();
    expect(h.store.size).toBe(0);
  });
});

describe("getTourRoute", () => {
  it("one Directions request per run, logged as tour_route for 90 days in the Directions bucket; legs cached without steps", async () => {
    h.postJson.mockResolvedValue({ status: 200, latencyMs: 1, body: fx("directions-foot-wien-fastest") });
    const r = await getTourRoute("foot-walking", "fastest", wien, ctx);
    expect(h.calls[0]).toMatchObject({ provider: "openrouteservice", endpoint: "tour_route", ttlSeconds: 90 * 86400 });
    expect(h.buckets).toEqual(["directions"]);
    expect(r).toMatchObject({ result: "ok", fetchedAt: "f1", stale: false });
    expect(r.result === "ok" && r.legs.map((l) => l.min)).toEqual([9, 15, 9, 15, 43]);
    expect(JSON.stringify([...h.store.values()])).not.toMatch(/steps|instruction/);
    await getTourRoute("foot-walking", "fastest", wien, ctx);
    expect(h.postJson).toHaveBeenCalledTimes(1);
  });

  it("not_routable and no_route are cached answers", async () => {
    h.postJson.mockRejectedValue(new HttpError(404, undefined, fx("directions-not-routable")));
    const pts = wien.slice(0, 2);
    expect(await getTourRoute("wheelchair", "shortest", pts, ctx)).toMatchObject({ result: "not_routable", point: 1 });
    expect(await getTourRoute("wheelchair", "shortest", pts, ctx)).toMatchObject({ result: "not_routable", point: 1, fetchedAt: "f0" });
    expect(h.postJson).toHaveBeenCalledTimes(1);
  });

  it("2002, 429, quota and no key → failed, not cached", async () => {
    h.postJson.mockRejectedValueOnce(new HttpError(400, undefined, fx("directions-weighting-factor-error")));
    expect(await getTourRoute("foot-walking", "green", wien, ctx)).toEqual({ result: "failed" });
    h.postJson.mockRejectedValueOnce(new HttpError(429));
    expect(await getTourRoute("foot-walking", "green", wien, ctx)).toEqual({ result: "failed" });
    h.quotaOk = false;
    expect(await getTourRoute("foot-walking", "green", wien, ctx)).toEqual({ result: "failed" });
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "");
    expect(await getTourRoute("foot-walking", "green", wien, ctx)).toEqual({ result: "failed" });
    expect(h.store.size).toBe(0);
  });
});

describe("getTourSteps (on request, spec 17.1 [P2])", () => {
  it("own key and endpoint (tour_steps, Directions bucket), steps kept; the route cache stays without steps", async () => {
    h.postJson.mockResolvedValue({ status: 200, latencyMs: 1, body: fx("directions-foot-wien-fastest") });
    expect(tourStepsKey("foot-walking", "fastest", wien)).not.toBe(tourRouteKey("foot-walking", "fastest", wien));
    const r = await getTourSteps("foot-walking", "fastest", wien, ctx);
    expect(h.calls[0]).toMatchObject({ provider: "openrouteservice", endpoint: "tour_steps", key: tourStepsKey("foot-walking", "fastest", wien), ttlSeconds: 90 * 86400 });
    expect(h.buckets).toEqual(["directions"]);
    expect(r.result === "ok" && r.legs).toHaveLength(5);
    expect(r.result === "ok" && r.legs[0].steps[1]).toEqual([1, "Stephansplatz", 85, 3]);
    expect(JSON.stringify([...h.store.values()])).not.toMatch(/instruction/);
    // Only the steps entry is written: the route cache gets no steps.
    expect(h.calls.map((c) => c.endpoint)).toEqual(["tour_steps"]);
    expect([...h.store.keys()]).toEqual([tourStepsKey("foot-walking", "fastest", wien)]);
    expect(h.store.has(tourRouteKey("foot-walking", "fastest", wien))).toBe(false);
    await getTourSteps("foot-walking", "fastest", wien, ctx);
    expect(h.postJson).toHaveBeenCalledTimes(1);
  });

  it("failures → failed, not cached", async () => {
    h.postJson.mockRejectedValueOnce(new HttpError(429));
    expect(await getTourSteps("foot-walking", "fastest", wien, ctx)).toEqual({ result: "failed" });
    h.quotaOk = false;
    expect(await getTourSteps("foot-walking", "fastest", wien, ctx)).toEqual({ result: "failed" });
    expect(h.store.size).toBe(0);
  });
});

describe("withinPolyBudget (cache rows stay under 256 kB)", () => {
  it("empties lines over their share; minutes and km stay", () => {
    const leg = (len: number) => ({ min: 5, km: 1, poly: "a".repeat(len) });
    const r = withinPolyBudget({ result: "ok", legs: Array.from({ length: 26 }, (_, i) => leg(i === 3 ? 9000 : 500)) });
    expect(r.result === "ok" && r.legs[3]).toEqual({ min: 5, km: 1, poly: "" }); // share = 200000 / 26 = 7692
    expect(r.result === "ok" && r.legs[0].poly).toHaveLength(500);
    expect(withinPolyBudget({ result: "no_route" })).toEqual({ result: "no_route" });
  });
});
