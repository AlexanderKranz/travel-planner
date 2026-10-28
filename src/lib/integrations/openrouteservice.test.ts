import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ postJson: vi.fn() }));
vi.mock("./http", () => ({ postJson: h.postJson }));

import { MAX_DRIVE_MIN, ORS_MATRIX_URL, fetchDriveMatrix, matrixBody, parseMatrix } from "./openrouteservice";

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
