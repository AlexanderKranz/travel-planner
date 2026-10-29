import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/health", () => ({ checkDb: async () => ({ ok: true, latencyMs: 1 }) }));

import { resetRateLimits } from "@/lib/server/rate-limit";
import { GET } from "./route";

const req = (ip?: string) => new Request("https://x.example/api/health", { headers: ip ? { "x-forwarded-for": ip } : {} });

beforeEach(resetRateLimits);

describe("GET /api/health", () => {
  it("answers ok with the db check", async () => {
    const res = await GET(req("203.0.113.1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", checks: { db: { ok: true } } });
  });

  it("limits a single IP to 30 requests per minute, other IPs are unaffected", async () => {
    for (let i = 0; i < 30; i++) expect((await GET(req("203.0.113.2"))).status).toBe(200);
    const blocked = await GET(req("203.0.113.2"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect((await GET(req("203.0.113.3"))).status).toBe(200);
  });

  it("does not limit when no proxy header is present", async () => {
    for (let i = 0; i < 40; i++) expect((await GET(req())).status).toBe(200);
  });
});
