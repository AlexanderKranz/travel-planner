import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// Outside React's server runtime `cache` is a pass-through; make it explicit and independent of the React build.
vi.mock("react", () => ({ cache: <T,>(fn: T) => fn }));

const getClaims = vi.fn();
const profile = vi.fn();
vi.mock("./supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getClaims: () => getClaims() },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => profile() }) }) }),
  }),
}));

import { getUserSession } from "./session";

beforeEach(() => {
  getClaims.mockReset();
  profile.mockReset();
  getClaims.mockResolvedValue({ data: { claims: { sub: "u1" } } });
  profile.mockResolvedValue({ data: { disabled_at: null }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getUserSession", () => {
  it("returns the session of an active user", async () => {
    expect(await getUserSession()).toMatchObject({ userId: "u1" });
  });
  it("is null when signed out, without a profile lookup", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect(await getUserSession()).toBeNull();
    expect(profile).not.toHaveBeenCalled();
  });
  it("is null for a disabled user even though the JWT is still valid", async () => {
    profile.mockResolvedValue({ data: { disabled_at: "2026-10-31T10:00:00Z" }, error: null });
    expect(await getUserSession()).toBeNull();
  });
  it("fails open when the lookup returns an error", async () => {
    profile.mockResolvedValue({ data: null, error: { code: "57014" } });
    expect(await getUserSession()).toMatchObject({ userId: "u1" });
  });
  it("fails open when the lookup throws", async () => {
    profile.mockRejectedValue(new Error("network"));
    expect(await getUserSession()).toMatchObject({ userId: "u1" });
  });
});
