import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { externalWriteAllowed, rateLimit, resetRateLimits } from "./rate-limit";

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

describe("externalWriteAllowed", () => {
  beforeEach(resetRateLimits);
  it("allows 30 writes per minute per user, users are independent", () => {
    for (let i = 0; i < 30; i++) expect(externalWriteAllowed("u1")).toBe(true);
    expect(externalWriteAllowed("u1")).toBe(false);
    expect(externalWriteAllowed("u2")).toBe(true);
  });
});

describe("rateLimitAvailable", () => {
  it("only looks: nothing is counted", async () => {
    const { rateLimit, rateLimitAvailable, resetRateLimits } = await import("./rate-limit");
    resetRateLimits();
    expect(rateLimitAvailable("k", 1, 0).ok).toBe(true);
    expect(rateLimitAvailable("k", 1, 0).ok).toBe(true);
    rateLimit("k", 1, 60_000, 0);
    expect(rateLimitAvailable("k", 1, 1000)).toEqual({ ok: false, retryAfterSeconds: 59 });
    expect(rateLimitAvailable("k", 1, 61_000).ok).toBe(true);
  });
});
