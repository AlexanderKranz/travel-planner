import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ postForm: vi.fn() }));
vi.mock("./http", async (orig) => ({ ...(await orig<typeof import("./http")>()), postForm: h.postForm }));

import { HttpError } from "./http";
import { DEFAULT_OVERPASS_URL, FALLBACK_OVERPASS_URL, OVERPASS_CLIENT_TIMEOUT_MS, SECOND_FALLBACK_OVERPASS_URL, bboxAround, overpassUrls, runQuery } from "./overpass";

const ok = (n = 1) => ({
  status: 200,
  latencyMs: 5,
  body: { elements: Array.from({ length: n }, (_, i) => ({ type: "node", id: i + 1, lat: 1, lon: 2, tags: { name: "x" } })) },
});

describe("bboxAround", () => {
  it("is symmetric around the centre and wider in longitude at high latitudes", () => {
    const b = bboxAround({ lat: 60, lon: 10 }, 30_000);
    expect((b.north + b.south) / 2).toBeCloseTo(60, 6);
    expect((b.north - b.south) / 2).toBeCloseTo(30 / 111.32, 5);
    expect(b.east - 10).toBeGreaterThan(b.north - 60);
  });
  it("clamps latitude at the poles", () => {
    expect(bboxAround({ lat: 89.9, lon: 0 }, 100_000).north).toBe(90);
  });
});

describe("runQuery with mirror fallback", () => {
  beforeEach(() => {
    h.postForm.mockReset();
    delete process.env.OVERPASS_URL;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses the primary with a 100 s client timeout", async () => {
    h.postForm.mockResolvedValueOnce(ok(2));
    const r = await runQuery("q");
    expect(r.elements).toHaveLength(2);
    expect(h.postForm).toHaveBeenCalledTimes(1);
    expect(h.postForm).toHaveBeenCalledWith(DEFAULT_OVERPASS_URL, { data: "q" }, { timeoutMs: OVERPASS_CLIENT_TIMEOUT_MS });
  });
  it.each([
    ["timeout", Object.assign(new Error("t"), { name: "TimeoutError" })],
    ["429", new HttpError(429)],
    ["504", new HttpError(504)],
  ])("falls back to the mirror once after %s", async (_n, err) => {
    h.postForm.mockRejectedValueOnce(err).mockResolvedValueOnce(ok());
    const r = await runQuery("q");
    expect(r.elements).toHaveLength(1);
    expect(h.postForm.mock.calls.map((c) => c[0])).toEqual([DEFAULT_OVERPASS_URL, FALLBACK_OVERPASS_URL]);
  });
  it("falls back after a runtime-error remark (HTTP 200)", async () => {
    h.postForm
      .mockResolvedValueOnce({ status: 200, latencyMs: 1, body: { elements: [], remark: "runtime error: Query timed out" } })
      .mockResolvedValueOnce(ok());
    expect((await runQuery("q")).elements).toHaveLength(1);
    expect(h.postForm).toHaveBeenCalledTimes(2);
  });
  it("tries each instance only once and rethrows the last error", async () => {
    h.postForm.mockRejectedValue(new HttpError(502));
    await expect(runQuery("q")).rejects.toMatchObject({ status: 502 });
    expect(h.postForm.mock.calls.map((c) => c[0])).toEqual([DEFAULT_OVERPASS_URL, FALLBACK_OVERPASS_URL, SECOND_FALLBACK_OVERPASS_URL]);
  });
  it("falls through to the third instance", async () => {
    h.postForm.mockRejectedValueOnce(new HttpError(504)).mockRejectedValueOnce(new HttpError(429)).mockResolvedValueOnce(ok(3));
    expect((await runQuery("q")).elements).toHaveLength(3);
  });
  it("an OVERPASS_URL equal to a mirror is not tried twice", () => {
    expect(overpassUrls({ OVERPASS_URL: SECOND_FALLBACK_OVERPASS_URL })).toEqual([SECOND_FALLBACK_OVERPASS_URL, FALLBACK_OVERPASS_URL]);
  });
  it("OVERPASS_URL overrides the primary; the mirror stays the fallback", async () => {
    vi.stubEnv("OVERPASS_URL", "https://example.test/api/interpreter");
    h.postForm.mockRejectedValueOnce(new HttpError(500)).mockResolvedValueOnce(ok());
    await runQuery("q");
    expect(h.postForm.mock.calls.map((c) => c[0])).toEqual(["https://example.test/api/interpreter", FALLBACK_OVERPASS_URL]); // second succeeded
  });
  it("skips the fallback and shortens timeouts when the deadline is near", async () => {
    h.postForm.mockRejectedValue(new HttpError(500));
    await expect(runQuery("q", { deadline: Date.now() + 10_000 })).rejects.toBeDefined();
    expect(h.postForm).toHaveBeenCalledTimes(1);
    expect(h.postForm.mock.calls[0][2].timeoutMs).toBeLessThanOrEqual(10_000);
  });
});

describe("mirrorLabel", () => {
  it("logs the host name only", async () => {
    const { mirrorLabel } = await import("./overpass");
    expect(mirrorLabel("https://overpass-api.de/api/interpreter?data=secret")).toBe("overpass-api.de");
    expect(mirrorLabel("not a url")).toBe("unknown");
  });
});
