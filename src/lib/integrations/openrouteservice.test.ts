import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ postJson: vi.fn() }));
vi.mock("./http", async (orig) => ({ ...(await orig<typeof import("./http")>()), postJson: h.postJson }));

import { HttpError } from "./http";
import {
  MAX_DRIVE_MIN,
  ORS_DIRECTIONS_URL,
  ORS_MATRIX_URL,
  directionsBody,
  fetchDriveMatrix,
  fetchDriveRoute,
  isNoRouteError,
  matrixBody,
  parseDirections,
  parseMatrix,
} from "./openrouteservice";

/** Recorded live 2026-10-28: Marbella → 3 golf courses + Palma de Mallorca (ferry route, 15 h). */
const fixture = JSON.parse(readFileSync(join(__dirname, "__fixtures__/openrouteservice/matrix-marbella.json"), "utf8"));
const marbella = { lat: 36.515, lon: -4.886 };
const dests = [
  { lat: 36.5363, lon: -4.6996 },
  { lat: 36.4669, lon: -5.0326 },
  { lat: 36.606, lon: -4.556 },
  { lat: 39.57, lon: 2.65 },
];

describe("openrouteservice matrix", () => {
  beforeEach(() => {
    h.postJson.mockReset();
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "test-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("body: [lon, lat], origin first, one source, all destinations, duration + distance in km", () => {
    expect(matrixBody(marbella, dests.slice(0, 2))).toEqual({
      locations: [[-4.886, 36.515], [-4.6996, 36.5363], [-5.0326, 36.4669]],
      sources: [0],
      destinations: [1, 2],
      metrics: ["duration", "distance"],
      units: "km",
    });
  });

  it("parses the recorded response: minutes, km (1 decimal); the ferry 'drive' is dropped", () => {
    expect(parseMatrix(fixture, 4)).toEqual([
      { min: 31, km: 28 },
      { min: 19, km: 16.5 },
      { min: 30, km: 40.9 },
      null, // 921 min > MAX_DRIVE_MIN
    ]);
    expect(MAX_DRIVE_MIN).toBe(180);
  });

  it("unreachable (null) stays null, never guessed; wrong shape throws", () => {
    expect(parseMatrix({ durations: [[600, null]], distances: [[10, null]] }, 2)).toEqual([{ min: 10, km: 10 }, null]);
    expect(() => parseMatrix({ durations: [[600]], distances: [[10]] }, 2)).toThrow();
    expect(() => parseMatrix({ error: { code: 6099 } }, 1)).toThrow();
  });

  it("sends the key only as Authorization header, to the matrix endpoint", async () => {
    h.postJson.mockResolvedValue({ status: 200, latencyMs: 5, body: fixture });
    const r = await fetchDriveMatrix(marbella, dests);
    expect(r.drives).toHaveLength(4);
    const [url, body, opts] = h.postJson.mock.calls[0];
    expect(url).toBe(ORS_MATRIX_URL);
    expect(JSON.stringify(body)).not.toContain("test-key");
    expect(opts.headers).toEqual({ Authorization: "test-key" });
  });

  it("missing key fails without a request; no destinations → no request", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "");
    await expect(fetchDriveMatrix(marbella, dests)).rejects.toThrow(/missing/);
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "k");
    expect((await fetchDriveMatrix(marbella, [])).drives).toEqual([]);
    expect(h.postJson).not.toHaveBeenCalled();
  });
});

const fixtureOf = (name: string) => JSON.parse(readFileSync(join(__dirname, "__fixtures__/openrouteservice", name), "utf8"));
const stralsund = { lat: 54.3091, lon: 13.0817 };
const sassnitz = { lat: 54.5133, lon: 13.6428 };
const marbellaCity = { lat: 36.51, lon: -4.8826 };
const palma = { lat: 39.5696, lon: 2.6502 };

describe("openrouteservice directions (ferries excluded)", () => {
  beforeEach(() => {
    h.postJson.mockReset();
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "test-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("body: [lon, lat], from first, ferries avoided, no geometry", () => {
    expect(directionsBody(stralsund, sassnitz)).toEqual({
      coordinates: [[13.0817, 54.3091], [13.6428, 54.5133]],
      units: "km",
      geometry: false,
      instructions: false,
      options: { avoid_features: ["ferries"] },
    });
  });

  it("parses the recorded Stralsund → Sassnitz route (Rügen has a bridge)", () => {
    expect(parseDirections(fixtureOf("directions-stralsund-sassnitz.json"))).toEqual({ min: 57, km: 51.8 });
  });

  it("a body without a route or with a wrong shape throws", () => {
    expect(() => parseDirections({ routes: [] })).toThrow();
    expect(() => parseDirections({ error: { code: 2099 } })).toThrow();
    expect(() => parseDirections({ routes: [{ summary: { distance: -1, duration: 5 } }] })).toThrow();
  });

  it("sends the key only as header, to the directions endpoint; ferries are excluded in the request", async () => {
    h.postJson.mockResolvedValue({ status: 200, latencyMs: 7, body: fixtureOf("directions-stralsund-sassnitz.json") });
    const r = await fetchDriveRoute(stralsund, sassnitz);
    expect(r).toEqual({ route: { road: true, min: 57, km: 51.8 }, status: 200, latencyMs: 7 });
    const [url, body, opts] = h.postJson.mock.calls[0];
    expect(url).toBe(ORS_DIRECTIONS_URL);
    expect(body.options).toEqual({ avoid_features: ["ferries"] });
    expect(JSON.stringify(body)).not.toContain("test-key");
    expect(opts.headers).toEqual({ Authorization: "test-key" });
  });

  it("the recorded 'no route' answer (404, code 2009) is a result, not an error", async () => {
    h.postJson.mockRejectedValue(new HttpError(404, undefined, fixtureOf("directions-no-route.json")));
    const r = await fetchDriveRoute(marbellaCity, palma);
    expect(r.route).toEqual({ road: false });
  });

  it("every other failure throws: timeout, 5xx, quota, unroutable point, 404 without the code, no body", async () => {
    const timeout = Object.assign(new Error("Timeout after 10000 ms"), { name: "TimeoutError" });
    const cases: unknown[] = [
      timeout,
      new HttpError(500, undefined, fixtureOf("matrix-ferry-option-error.json")),
      new HttpError(429),
      new HttpError(404, undefined, { error: { code: 2010, message: "Could not find routable point" } }),
      new HttpError(404),
      new HttpError(403, undefined, { error: "Access to this API has been disallowed" }),
    ];
    for (const c of cases) {
      h.postJson.mockRejectedValueOnce(c);
      await expect(fetchDriveRoute(marbellaCity, palma)).rejects.toBe(c);
    }
    expect(isNoRouteError(new HttpError(500, undefined, fixtureOf("directions-no-route.json")))).toBe(false);
    expect(isNoRouteError(new Error("x"))).toBe(false);
  });

  it("missing key fails without a request", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "");
    await expect(fetchDriveRoute(stralsund, sassnitz)).rejects.toThrow(/missing/);
    expect(h.postJson).not.toHaveBeenCalled();
  });
});
