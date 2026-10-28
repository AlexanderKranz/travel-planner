import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ search: vi.fn(async () => []) }));
vi.mock("@/lib/server/session", () => ({ getUserSession: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/integrations/open-meteo-geocoding", () => ({ searchPlaces: h.search }));

import { resetRateLimits } from "@/lib/server/rate-limit";
import { GET } from "./route";

const req = () => new Request("http://x/api/geocode?q=paris&lang=en");

describe("GET /api/geocode rate limit", () => {
  beforeEach(resetRateLimits);
  it("returns 429 with rate_limited after 30 requests per minute", async () => {
    for (let i = 0; i < 30; i++) expect((await GET(req())).status).toBe(200);
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ results: [], error: "rate_limited" });
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});
