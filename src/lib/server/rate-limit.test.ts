import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { rateLimit, resetRateLimits } from "./rate-limit";

describe("rateLimit", () => {
  beforeEach(resetRateLimits);
  it("allows up to the limit, then blocks with retry-after", () => {
    for (let i = 0; i < 3; i++) expect(rateLimit("u", 3, 60_000, 1000).ok).toBe(true);
    const r = rateLimit("u", 3, 60_000, 1000);
    expect(r.ok).toBe(false);
    expect(r.retryAfterSeconds).toBe(60);
  });
  it("keys are independent and the window resets", () => {
    for (let i = 0; i < 3; i++) rateLimit("a", 3, 1000, 0);
    expect(rateLimit("a", 3, 1000, 500).ok).toBe(false);
    expect(rateLimit("b", 3, 1000, 500).ok).toBe(true);
    expect(rateLimit("a", 3, 1000, 1000).ok).toBe(true);
  });
});
