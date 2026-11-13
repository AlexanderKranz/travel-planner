import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ postJson: vi.fn() }));
vi.mock("./http", async (orig) => ({ ...(await orig<typeof import("./http")>()), postJson: h.postJson }));

import { HttpError } from "./http";
import {
  ORS_DIRECTIONS_TIMEOUT_MS,
  ORS_TIMEOUT_MS,
  TOUR_OPTIONS_BY_PROFILE,
  fetchMatrixFull,
  fetchRoute,
  fetchRouteSteps,
  notRoutablePoint,
  orsDirectionsUrl,
  orsMatrixUrl,
  parseTourMatrix,
  parseTourRoute,
  parseTourRouteSteps,
  tourMatrixBody,
  tourRouteBody,
} from "./openrouteservice";
import type { RouteOption } from "@/lib/domain/tour";
import { decodePolyline } from "@/lib/tour/polyline";

/** Recorded live 2026-11-12 (city tour spike), bodies only. */
const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, "__fixtures__/ors-tour", `${name}.json`), "utf8"));
const noRoute = JSON.parse(readFileSync(join(__dirname, "__fixtures__/openrouteservice/directions-no-route.json"), "utf8"));

/** Wien, in the spike's order: Stephansdom, Hofburg, Naschmarkt, Karlskirche, Oberes Belvedere, Riesenrad. */
const wien = [
  { lat: 48.2085, lon: 16.3731 },
  { lat: 48.2065, lon: 16.3655 },
  { lat: 48.199, lon: 16.363 },
  { lat: 48.1981, lon: 16.3716 },
  { lat: 48.1915, lon: 16.381 },
  { lat: 48.2166, lon: 16.3958 },
];
const coords = wien.map((p) => [p.lon, p.lat]);

beforeEach(() => {
  h.postJson.mockReset();
  vi.stubEnv("OPENROUTESERVICE_API_KEY", "test-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("tour matrix (foot-walking, Wien)", () => {
  it("body: [lon, lat] locations, durations only", () => {
    expect(tourMatrixBody(wien)).toEqual({ locations: coords, metrics: ["duration"] });
  });

  it("parses 6 x 6 seconds and the snapped distances", () => {
    const m = parseTourMatrix(fx("matrix-foot-wien"), 6);
    expect(m.durations).toHaveLength(6);
    expect(m.durations.every((r) => r.length === 6)).toBe(true);
    expect(m.durations[0][1]).toBe(551.46);
    expect(m.durations[4][5]).toBe(2560.1);
    expect(m.durations[3][3]).toBe(0);
    expect(m.snappedM).toEqual([27.94, 34.89, 27.04, 9.62, 15.13, 30.44]);
  });

  it("null and impossible cells stay null; a wrong size is a shape error", () => {
    const body = { durations: [[0, null], [-5, 0]] };
    expect(parseTourMatrix(body, 2)).toEqual({ durations: [[0, null], [null, 0]], snappedM: [null, null] });
    expect(() => parseTourMatrix(fx("matrix-foot-wien"), 5)).toThrow();
  });

  it("fetchMatrixFull posts to the profile's matrix URL with the key and the default timeout", async () => {
    h.postJson.mockResolvedValue({ status: 200, latencyMs: 700, body: fx("matrix-foot-wien") });
    const r = await fetchMatrixFull("foot-walking", wien);
    expect(h.postJson).toHaveBeenCalledWith(
      "https://api.heigit.org/openrouteservice/v2/matrix/foot-walking",
      { locations: coords, metrics: ["duration"] },
      { timeoutMs: ORS_TIMEOUT_MS, headers: { Authorization: "test-key" } },
    );
    expect(orsMatrixUrl("wheelchair")).toBe("https://api.heigit.org/openrouteservice/v2/matrix/wheelchair");
    expect(r.matrix.durations[1][2]).toBe(875.77);
  });

  it("refuses a missing key, one point or more than 27 points without a call", async () => {
    await expect(fetchMatrixFull("foot-walking", wien.slice(0, 1))).rejects.toThrow(RangeError);
    await expect(fetchMatrixFull("foot-walking", Array(28).fill(wien[0]))).rejects.toThrow(RangeError);
    await expect(fetchRoute("foot-walking", Array(28).fill(wien[0]), "fastest")).rejects.toThrow(RangeError);
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "");
    await expect(fetchMatrixFull("foot-walking", wien)).rejects.toMatchObject({ name: "MissingKeyError" });
    expect(h.postJson).not.toHaveBeenCalled();
  });

  it("27 points (25 places + start + end, spec 17.1 [P1]) pass the guard and reach ORS", async () => {
    h.postJson.mockRejectedValue(new HttpError(503));
    await expect(fetchMatrixFull("foot-walking", Array(27).fill(wien[0]))).rejects.toMatchObject({ status: 503 });
    await expect(fetchRoute("foot-walking", Array(27).fill(wien[0]), "fastest")).rejects.toMatchObject({ status: 503 });
    expect(h.postJson).toHaveBeenCalledTimes(2);
  });
});

describe("tour directions: request bodies (exactly the spike's table)", () => {
  const common = { coordinates: coords, geometry: true, instructions: true, elevation: false, units: "km" };
  const cases: [RouteOption, object][] = [
    ["fastest", { ...common, preference: "fastest", options: { avoid_features: ["ferries"] } }],
    ["shortest", { ...common, preference: "shortest", options: { avoid_features: ["ferries"] } }],
    ["green", { ...common, preference: "recommended", options: { avoid_features: ["ferries"], profile_params: { weightings: { green: 1 } } } }],
    ["quiet", { ...common, preference: "recommended", options: { avoid_features: ["ferries"], profile_params: { weightings: { quiet: 1 } } } }],
    ["no_steps", { ...common, preference: "fastest", options: { avoid_features: ["ferries", "steps"] } }],
    ["no_highways", { ...common, preference: "recommended", options: { avoid_features: ["ferries", "highways"] } }],
  ];
  it.each(cases)("%s", (option, body) => {
    expect(tourRouteBody(wien, option)).toStrictEqual(body);
  });

  it("weightings are plain numbers, never the docs' { factor } objects (rejected live with 2002)", () => {
    expect(JSON.stringify(tourRouteBody(wien, "green"))).not.toContain("factor");
  });

  it("the recorded requests ORS echoed match our option fields", () => {
    const q = (name: string) => fx(name).metadata.query;
    expect(q("directions-foot-wien-fastest")).toMatchObject({ preference: "fastest", instructions: true, options: { avoid_features: ["ferries"] } });
    expect(q("directions-foot-wien-green")).toMatchObject({ preference: "recommended", options: { profile_params: { weightings: { green: 1 } } } });
    expect(q("directions-foot-passau-quiet")).toMatchObject({ preference: "recommended", options: { profile_params: { weightings: { quiet: 1 } } } });
    expect(q("directions-foot-wien-no-steps").options.avoid_features).toEqual(["ferries", "steps"]);
    expect(q("directions-car-wien-no-highways")).toMatchObject({ preference: "recommended", options: { avoid_features: ["ferries", "highways"] } });
  });

  it("only the options ORS accepted per profile are allowed", () => {
    expect(TOUR_OPTIONS_BY_PROFILE).toEqual({
      "foot-walking": ["fastest", "shortest", "green", "quiet", "no_steps"],
      wheelchair: ["fastest", "shortest"],
      "cycling-regular": ["fastest", "shortest", "quiet"],
      "driving-car": ["fastest", "shortest", "no_highways"],
    });
  });
});

describe("tour directions: parsing", () => {
  it("6 waypoints → 5 legs whose minutes and km match the segments", () => {
    const legs = parseTourRoute(fx("directions-foot-wien-fastest"), 6);
    expect(legs.map(({ min, km }) => ({ min, km }))).toEqual([
      { min: 9, km: 0.77 }, // 551.5 s, 0.766 km
      { min: 15, km: 1.22 }, // 875.8 s
      { min: 9, km: 0.73 }, // 523 s
      { min: 15, km: 1.29 }, // 929.8 s
      { min: 43, km: 3.56 }, // 2560.1 s
    ]);
  });

  it("each leg's polyline starts and ends at the snapped waypoints (matrix snapped locations)", () => {
    const legs = parseTourRoute(fx("directions-foot-wien-fastest"), 6);
    const snapped = (fx("matrix-foot-wien").sources as { location: [number, number] }[]).map((s) => s.location);
    legs.forEach((leg, i) => {
      const pts = decodePolyline(leg.poly);
      const [aLat, aLon] = pts[0];
      const [bLat, bLon] = pts[pts.length - 1];
      expect(Math.abs(aLat - snapped[i][1])).toBeLessThanOrEqual(1e-5);
      expect(Math.abs(aLon - snapped[i][0])).toBeLessThanOrEqual(1e-5);
      expect(Math.abs(bLat - snapped[i + 1][1])).toBeLessThanOrEqual(1e-5);
      expect(Math.abs(bLon - snapped[i + 1][0])).toBeLessThanOrEqual(1e-5);
    });
    // way_points [0, 40, 124, 168, 220, 398]: inclusive slices, 399 points in total.
    expect(legs.map((l) => decodePolyline(l.poly).length)).toEqual([41, 85, 45, 53, 179]);
  });

  it("steps (instructions) never reach the result", () => {
    const body = fx("directions-foot-wien-fastest");
    expect(JSON.stringify(body)).toContain('"steps"');
    const legs = parseTourRoute(body, 6);
    expect(legs.every((l) => Object.keys(l).sort().join() === "km,min,poly")).toBe(true);
    expect(JSON.stringify(legs)).not.toMatch(/steps|instruction/);
  });

  it("other profiles and options parse too (wheelchair, car no_highways, Passau quiet, cycling)", () => {
    expect(parseTourRoute(fx("directions-wheelchair-wien-fastest"), 6).map((l) => l.min)).toEqual([10, 17, 8, 15, 52]);
    expect(parseTourRoute(fx("directions-car-wien-no-highways"), 6).map((l) => l.km)).toEqual([2.77, 1.38, 1.8, 2.18, 4.02]);
    expect(parseTourRoute(fx("directions-foot-passau-quiet"), 4).map((l) => l.min)).toEqual([8, 10, 37]);
    expect(parseTourRoute(fx("directions-cycling-passau-quiet"), 2)).toHaveLength(1);
  });

  it("a response without segments (instructions off) is a shape error, not zero legs", () => {
    expect(() => parseTourRoute(fx("directions-foot-wien-no-segments"), 6)).toThrow();
    expect(() => parseTourRoute(fx("directions-foot-wien-fastest"), 5)).toThrow();
  });
});

describe("fetchRoute", () => {
  it("posts the option body to the profile's Directions URL with the Directions timeout", async () => {
    h.postJson.mockResolvedValue({ status: 200, latencyMs: 210, body: fx("directions-foot-wien-green") });
    const r = await fetchRoute("foot-walking", wien, "green");
    expect(h.postJson).toHaveBeenCalledWith(orsDirectionsUrl("foot-walking"), tourRouteBody(wien, "green"), {
      timeoutMs: ORS_DIRECTIONS_TIMEOUT_MS,
      headers: { Authorization: "test-key" },
    });
    expect(orsDirectionsUrl("cycling-regular")).toBe("https://api.heigit.org/openrouteservice/v2/directions/cycling-regular/json");
    expect(r.route).toMatchObject({ result: "ok" });
    expect(r.route.result === "ok" && r.route.legs).toHaveLength(5);
  });

  it("2010 → not_routable with the 0-based point index from the message", async () => {
    h.postJson.mockRejectedValue(new HttpError(404, undefined, fx("directions-not-routable")));
    const passau = [{ lat: 48.5741, lon: 13.4648 }, { lat: 48.5712, lon: 13.465 }];
    const r = await fetchRoute("wheelchair", passau, "shortest");
    expect(r.route).toEqual({ result: "not_routable", point: 1 });
    expect(r.status).toBe(404);
  });

  it("2009 → no_route", async () => {
    h.postJson.mockRejectedValue(new HttpError(404, undefined, noRoute));
    expect((await fetchRoute("foot-walking", wien.slice(0, 2), "fastest")).route).toEqual({ result: "no_route" });
  });

  it("400/2002 (a weighting the API rejects), 429, 5xx and timeouts throw (failed), never an answer", async () => {
    const weighting = new HttpError(400, undefined, fx("directions-weighting-factor-error"));
    h.postJson.mockRejectedValueOnce(weighting);
    await expect(fetchRoute("foot-walking", wien, "green")).rejects.toBe(weighting);
    h.postJson.mockRejectedValueOnce(new HttpError(429));
    await expect(fetchRoute("foot-walking", wien, "fastest")).rejects.toMatchObject({ status: 429 });
    h.postJson.mockRejectedValueOnce(new HttpError(503));
    await expect(fetchRoute("foot-walking", wien, "fastest")).rejects.toMatchObject({ status: 503 });
    h.postJson.mockRejectedValueOnce(Object.assign(new Error("Timeout"), { name: "TimeoutError" }));
    await expect(fetchRoute("foot-walking", wien, "fastest")).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("a 2010 without a usable index is a failure", () => {
    const body = (message: string) => ({ error: { code: 2010, message } });
    expect(notRoutablePoint(new HttpError(404, undefined, body("no index here")), 2)).toBeNull();
    expect(notRoutablePoint(new HttpError(404, undefined, body("specified coordinate 7: 1 2")), 2)).toBeNull();
    expect(notRoutablePoint(new HttpError(500, undefined, body("specified coordinate 0: 1 2")), 2)).toBeNull();
    expect(notRoutablePoint(new HttpError(404, undefined, body("specified coordinate 0: 1 2")), 2)).toBe(0);
  });

  it("refuses an option the profile does not offer, without a call", async () => {
    await expect(fetchRoute("driving-car", wien, "green")).rejects.toThrow(RangeError);
    await expect(fetchRoute("wheelchair", wien, "quiet")).rejects.toThrow(RangeError);
    expect(h.postJson).not.toHaveBeenCalled();
  });
});

describe("tour directions with steps (on request, spec 17.1 [P2])", () => {
  it("keeps each segment's steps, compact and relative to its leg; unnamed ways become empty", () => {
    const body = fx("directions-foot-wien-fastest");
    const legs = parseTourRouteSteps(body, 6);
    const plain = parseTourRoute(body, 6);
    expect(legs.map((l) => ({ min: l.min, km: l.km, poly: l.poly }))).toEqual(plain);
    const route = body.routes[0];
    legs.forEach((leg, i) => {
      expect(leg.steps).toHaveLength(route.segments[i].steps.length);
      const span = route.way_points[i + 1] - route.way_points[i];
      for (const [type, name, metres, wp] of leg.steps) {
        expect(type).toBeGreaterThanOrEqual(0);
        expect(name).not.toBe("-");
        expect(metres).toBeGreaterThanOrEqual(0);
        expect(wp).toBeGreaterThanOrEqual(0);
        expect(wp).toBeLessThanOrEqual(span);
      }
    });
    expect(legs[0].steps[0]).toEqual([11, "", 32, 0]);
    expect(legs[0].steps[1]).toEqual([1, "Stephansplatz", 85, 3]);
  });

  it("keeps the exit number on a roundabout entry (type 7) only", () => {
    const body = {
      routes: [
        {
          geometry: "_p~iF~ps|U_ulLnnqC",
          way_points: [0, 1],
          segments: [
            {
              distance: 1,
              duration: 60,
              steps: [
                { type: 7, name: "Ring", distance: 0.2, way_points: [0, 1], exit_number: 2 },
                { type: 8, name: "Ring", distance: 0.1, way_points: [1, 1], exit_number: 2 },
                { type: 10, name: "-", distance: 0, way_points: [1, 1] },
              ],
            },
          ],
        },
      ],
    };
    expect(parseTourRouteSteps(body, 2)[0].steps).toEqual([[7, "Ring", 200, 0, 2], [8, "Ring", 100, 1], [10, "", 0, 1]]);
  });

  it("fetchRouteSteps posts the same body as fetchRoute", async () => {
    h.postJson.mockResolvedValue({ status: 200, latencyMs: 120, body: fx("directions-foot-wien-fastest") });
    const r = await fetchRouteSteps("foot-walking", wien, "fastest");
    expect(h.postJson).toHaveBeenCalledWith(orsDirectionsUrl("foot-walking"), tourRouteBody(wien, "fastest"), {
      timeoutMs: ORS_DIRECTIONS_TIMEOUT_MS,
      headers: { Authorization: "test-key" },
    });
    expect(r.route.result === "ok" && r.route.legs[0].steps.length).toBeGreaterThan(0);
  });
});
