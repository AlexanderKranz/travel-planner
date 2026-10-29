import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  load: vi.fn(),
  state: vi.fn(),
  generate: vi.fn(),
  iterate: vi.fn(),
}));
vi.mock("@/lib/server/plan-pipeline", () => ({
  loadPlanContext: h.load,
  loadPlanState: h.state,
  generatePlan: h.generate,
  iteratePlan: h.iterate,
}));

import { POST as iterate, maxDuration as iterMax } from "./iterate/route";
import { GET, POST, maxDuration } from "./route";

const params = { params: Promise.resolve({ id: "t1" }) };
const post = (body: unknown) => new Request("http://x/api/trips/t1/plan", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  h.load.mockResolvedValue({ ok: true, ctx: {} });
});

describe("plan routes", () => {
  it("allow 300 s", () => {
    expect(maxDuration).toBe(300);
    expect(iterMax).toBe(300);
  });
  it("GET: 401 without session, no-store", async () => {
    h.load.mockResolvedValue({ ok: false, error: "unauthenticated" });
    const res = await GET(new Request("http://x/api/trips/t1/plan"), params);
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("GET: 404 for unknown trip", async () => {
    h.load.mockResolvedValue({ ok: false, error: "not_found" });
    expect((await GET(new Request("http://x/p"), params)).status).toBe(404);
  });
  it("GET: returns { state }", async () => {
    h.state.mockResolvedValue({ ok: true, state: { tripId: "t1" } });
    const res = await GET(new Request("http://x/p?v=2"), params);
    expect(await res.json()).toEqual({ state: { tripId: "t1" } });
    expect(h.state).toHaveBeenCalledWith({}, 2);
  });
  it("GET: bad version is 422", async () => {
    expect((await GET(new Request("http://x/p?v=abc"), params)).status).toBe(422);
  });
  it("POST: invalid body is 422, anonymous is 401", async () => {
    expect((await POST(post({ locale: "xx" }), params)).status).toBe(422);
    h.load.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect((await POST(post({}), params)).status).toBe(401);
  });
  it("POST: passes locale, never the abort signal", async () => {
    h.generate.mockResolvedValue({ ok: true, data: { state: {}, unchanged: true } });
    const res = await POST(post({ locale: "de" }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: {}, unchanged: true });
    expect(h.generate).toHaveBeenCalledWith("t1", "de", { force: false, fresh: false, placesLoaded: false });
  });
  it("POST: force passes through; places_pending is 503 with Retry-After", async () => {
    h.generate.mockResolvedValue({ ok: false, error: "places_pending", retryAfter: 60 });
    const res = await POST(post({ locale: "en", force: true }), params);
    expect(h.generate).toHaveBeenCalledWith("t1", "en", { force: true, fresh: false, placesLoaded: false });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toEqual({ error: "places_pending", retryAfter: 60 });
  });
  it("POST: placesLoaded passes through (client already ran the places request)", async () => {
    h.generate.mockResolvedValue({ ok: true, data: { state: {} } });
    await POST(post({ locale: "de", placesLoaded: true }), params);
    expect(h.generate).toHaveBeenCalledWith("t1", "de", { force: false, fresh: false, placesLoaded: true });
  });
  it.each([
    ["busy", 409],
    ["conflict", 409],
    ["too_long", 422],
    ["outdated", 422],
    ["budget_exceeded", 429],
    ["ai_unavailable", 502],
    ["ai_refused", 502],
    ["invalid_output", 502],
    ["ai_disabled", 503],
  ] as const)("POST: maps %s to %i", async (error, status) => {
    h.generate.mockResolvedValue({ ok: false, error });
    const res = await POST(post({ locale: "en" }), params);
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(error);
  });
  it("POST: 429 carries Retry-After and resetAt", async () => {
    h.generate.mockResolvedValue({ ok: false, error: "rate_limited", retryAfter: 17 });
    const res = await POST(post({ locale: "en" }), params);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("17");
    h.generate.mockResolvedValue({ ok: false, error: "budget_exceeded", resetAt: "2026-10-28T23:00:00.000Z" });
    expect((await (await POST(post({ locale: "en" }), params)).json()).resetAt).toBe("2026-10-28T23:00:00.000Z");
  });
  it("iterate: forwards base version and feedback, returns reply", async () => {
    h.iterate.mockResolvedValue({ ok: true, data: { state: {}, reply: "ok" } });
    const res = await iterate(post({ locale: "en", baseVersion: 2, feedback: { chips: ["more_rest"] } }), params);
    expect(await res.json()).toEqual({ state: {}, reply: "ok" });
    expect(h.iterate).toHaveBeenCalledWith("t1", 2, { chips: ["more_rest"] }, "en");
  });
  it("iterate: 422 for a bad body", async () => {
    expect((await iterate(post({ locale: "en" }), params)).status).toBe(422);
  });
});
