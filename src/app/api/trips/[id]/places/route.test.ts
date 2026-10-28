import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  session: vi.fn(async () => ({ userId: "u1" }) as { userId: string } | null),
  getTrip: vi.fn(),
  places: vi.fn(async () => ({ status: "unavailable", reason: "provider_error" })),
}));
vi.mock("@/lib/server/session", () => ({ getUserSession: h.session }));
vi.mock("@/lib/server/trips", () => ({ getTrip: h.getTrip }));
vi.mock("@/lib/server/purposes", () => ({ getPurpose: async () => ({ ok: false, error: "not_found" }) }));
vi.mock("@/lib/server/facts/places", () => ({ getPlacesFacts: h.places, PLACES_REQUEST_BUDGET_MS: 280_000 }));

import { resetRateLimits } from "@/lib/server/rate-limit";
import { GET, maxDuration } from "./route";

const call = () => GET(new Request("http://x/api/trips/t1/places?locale=en"), { params: Promise.resolve({ id: "t1" }) });

describe("GET /api/trips/[id]/places", () => {
  beforeEach(() => {
    resetRateLimits();
    h.session.mockResolvedValue({ userId: "u1" });
    h.getTrip.mockResolvedValue({ ok: true, data: { id: "t1", purposeId: null } });
    h.places.mockClear();
  });
  it("allows 300 s", () => expect(maxDuration).toBe(300));
  it("401 without session", async () => {
    h.session.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });
  it("404 for unknown or foreign trips (RLS)", async () => {
    h.getTrip.mockResolvedValue({ ok: false, error: "not_found" });
    expect((await call()).status).toBe(404);
    expect(h.places).not.toHaveBeenCalled();
  });
  it("returns the fact with no-store and the 280 s budget", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(h.places.mock.calls[0]).toMatchObject([{}, null, { userId: "u1", locale: "en" }, { budgetMs: 280_000 }]);
  });
  it("429 after 12 requests per minute", async () => {
    for (let i = 0; i < 12; i++) expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });
});
