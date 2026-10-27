import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const logEvent = vi.fn<(e: unknown) => Promise<void>>(async () => {});
const verifyOtp = vi.fn();
vi.mock("@/lib/server/events", () => ({ logEvent: (e: unknown) => logEvent(e) }));
vi.mock("@/lib/server/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { verifyOtp } }),
}));

import { GET } from "./route";

const ORIGIN = "https://travel.example";
const hash = "abcdefghijklmnop";
const call = (qs: string) => GET(new NextRequest(`${ORIGIN}/auth/confirm?${qs}`));
const loc = (res: Response) => new URL(res.headers.get("location")!);

beforeEach(() => {
  logEvent.mockClear();
  verifyOtp.mockReset();
  verifyOtp.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
});

describe("GET /auth/confirm", () => {
  it("redirects to /<locale>/app on success", async () => {
    const res = await call(`token_hash=${hash}&type=email&locale=en`);
    expect(loc(res).origin).toBe(ORIGIN);
    expect(loc(res).pathname).toBe("/en/app");
    expect(verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: hash });
  });

  it("keeps the locale on the login redirect when the token is malformed", async () => {
    const res = await call("token_hash=x&type=email&locale=en");
    expect(loc(res).pathname).toBe("/en/login");
  });

  it("falls back to the default locale for missing or hostile locale values", async () => {
    for (const locale of ["", "../../evil", "//evil.com", "zz"]) {
      const res = await call(`token_hash=${hash}&type=email&locale=${encodeURIComponent(locale)}`);
      expect(loc(res).origin).toBe(ORIGIN);
      expect(loc(res).pathname).toBe("/de/app");
    }
  });

  it("never leaves the origin, whatever `next` contains", async () => {
    const nexts = [
      "//evil.com",
      "https://evil.com",
      "/\\evil.com",
      "/\t/evil.com",
      "/\n/evil.com",
      "/%2F%2Fevil.com",
      "/../../evil.com",
      "@evil.com",
    ];
    for (const next of nexts) {
      const res = await call(`token_hash=${hash}&type=email&locale=de&next=${encodeURIComponent(next)}`);
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(loc(res).origin, `next=${JSON.stringify(next)}`).toBe(ORIGIN);
      expect(loc(res).host).toBe("travel.example");
    }
  });

  it("honours a same-site next path with its query string", async () => {
    const res = await call(`token_hash=${hash}&type=email&locale=de&next=${encodeURIComponent("/en/app/groups?x=1")}`);
    expect(loc(res).pathname).toBe("/en/app/groups");
    expect(loc(res).search).toBe("?x=1");
  });

  it("redirects to login without calling Supabase on a malformed query", async () => {
    const res = await call("type=email&locale=en");
    // The locale is parsed separately, so a bad token keeps the user's language.
    expect(loc(res).pathname).toBe("/en/login");
    expect(loc(res).search).toBe("?error=link_invalid");
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("redirects to login when the token is rejected", async () => {
    verifyOtp.mockResolvedValue({ data: { user: null }, error: { code: "otp_expired" } });
    const res = await call(`token_hash=${hash}&type=email&locale=en`);
    expect(loc(res).pathname).toBe("/en/login");
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "auth.login_failed" }));
  });

  it("does not put the token hash or any email into event logs", async () => {
    verifyOtp.mockResolvedValue({ data: { user: null }, error: { code: "otp_expired", message: "a@b.de" } });
    await call(`token_hash=${hash}&type=email`);
    verifyOtp.mockResolvedValue({ data: { user: { id: "u1", email: "a@b.de" } }, error: null });
    await call(`token_hash=${hash}&type=email`);
    const logged = JSON.stringify(logEvent.mock.calls);
    expect(logged).not.toContain(hash);
    expect(logged).not.toContain("@");
  });
});
