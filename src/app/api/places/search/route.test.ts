import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  session: true,
  autocomplete: vi.fn(),
  reserve: vi.fn(),
}));
vi.mock("@/lib/server/session", () => ({ getUserSession: async () => (h.session ? { userId: "u1" } : null) }));
vi.mock("@/lib/server/facts/place-search", () => ({ autocompletePlaces: h.autocomplete }));
vi.mock("@/lib/server/ai-slots", () => ({ reserveAiCall: h.reserve }));

import { parseAutocomplete } from "@/lib/integrations/geoapify-autocomplete";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { verifyPointRef } from "@/lib/server/tour/point-ref";
import { GET } from "./route";

/** Recorded live 2026-11-12 (city tour spike): "Stephansdom" around Wien. */
const body = JSON.parse(
  readFileSync(join(__dirname, "../../../../lib/integrations/__fixtures__/geoapify-autocomplete/autocomplete-stephansdom-wien-de.json"), "utf8"),
);
const req = (qs = "q=Stephansdom&lat=48.2085&lon=16.3731&lang=de") => new Request(`http://x/api/places/search?${qs}`);

beforeEach(() => {
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
  resetRateLimits();
  h.session = true;
  h.autocomplete.mockReset().mockResolvedValue({ ok: true, suggestions: parseAutocomplete(body), fetchedAt: "2026-11-12T00:00:00.000Z", stale: false });
  h.reserve.mockReset().mockResolvedValue({ ok: true, id: "s", pending: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/places/search", () => {
  it("requires a login", async () => {
    h.session = false;
    expect((await GET(req())).status).toBe(401);
    expect(h.autocomplete).not.toHaveBeenCalled();
  });

  it("needs at least 3 characters and a valid point; no slot is taken for a bad query", async () => {
    expect((await GET(req("q=st&lat=48.2&lon=16.3"))).status).toBe(400);
    expect((await GET(req("q=stephan&lat=91&lon=16.3"))).status).toBe(400);
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it("returns suggestions with signed references (key, name, address, category, distance), no raw place_id", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results.length).toBeGreaterThan(0);
    const first = json.results[0];
    expect(first).toMatchObject({ key: expect.stringMatching(/^gfy:[0-9a-f]{32}$/), name: "Stephansdom", source: "geoapify" });
    expect(first).not.toHaveProperty("placeId");
    expect(verifyPointRef(first.ref, first.key)).toMatchObject({ p: { key: first.key }, g: { osm: true } });
    expect(h.autocomplete).toHaveBeenCalledWith({ q: "Stephansdom", lat: 48.2085, lon: 16.3731, lang: "de" }, { userId: "u1" });
    expect(h.reserve.mock.calls[0][0]).toMatchObject({ userId: "u1", task: "place_search", perMinute: 30, perDay: 200 });
  });

  it("30 per minute per user (in memory), then 429", async () => {
    for (let i = 0; i < 30; i++) expect((await GET(req())).status).toBe(200);
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ results: [], error: "rate_limited" });
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("200 per Berlin day (durable count) → 429 daily_limit until midnight; unreadable count → 503", async () => {
    h.reserve.mockResolvedValue({ ok: false, reason: "day" });
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ results: [], error: "daily_limit" });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(h.autocomplete).not.toHaveBeenCalled();
    h.reserve.mockRejectedValue(new Error("db"));
    expect((await GET(req())).status).toBe(503);
  });

  it("Geoapify down or out of credits: 200 with no results and `unavailable`", async () => {
    h.autocomplete.mockResolvedValue({ ok: false, error: "unavailable" });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [], error: "unavailable" });
  });
});
