import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const logEvent = vi.fn<(e: unknown) => Promise<void>>(async () => {});
const verifyOtp = vi.fn();
const exchangeCodeForSession = vi.fn();
vi.mock("@/lib/server/events", () => ({ logEvent: (e: unknown) => logEvent(e) }));
vi.mock("@/lib/server/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { verifyOtp, exchangeCodeForSession } }),
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
  exchangeCodeForSession.mockReset();
  exchangeCodeForSession.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
});

describe("GET /auth/confirm with Supabase's default link (?code=)", () => {
  const code = "0123456789abcdef";

  it("exchanges the code and redirects to /<locale>/app", async () => {
    const res = await call(`locale=en&code=${code}`);
    expect(exchangeCodeForSession).toHaveBeenCalledWith(code);
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(loc(res).origin).toBe(ORIGIN);
    expect(loc(res).pathname).toBe("/en/app");
  });

  it("sends the user back to the login page when the exchange fails", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { user: null }, error: { code: "bad_code_verifier" } });
    const res = await call(`locale=de&code=${code}`);
    expect(loc(res).pathname).toBe("/de/login");
    expect(loc(res).searchParams.get("error")).toBe("link_invalid");
  });

  it("rejects malformed codes without calling Supabase", async () => {
    const res = await call("locale=de&code=x");
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(loc(res).pathname).toBe("/de/login");
  });

  it("never leaves the origin via `next`", async () => {
    const res = await call(`locale=de&code=${code}&next=${encodeURIComponent("//evil.com")}`);
    expect(loc(res).origin).toBe(ORIGIN);
    expect(loc(res).pathname).toBe("/de/app");
  });
});

describe("GET /auth/confirm with a password reset link (type=recovery)", () => {
  const next = encodeURIComponent("/en/settings?focus=password");

  it("verifies the recovery token and lands on the settings password section", async () => {
    const res = await call(`token_hash=${hash}&type=recovery&locale=en&next=${next}`);
    expect(verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: hash });
    expect(loc(res).origin).toBe(ORIGIN);
    expect(loc(res).pathname).toBe("/en/settings");
    expect(loc(res).searchParams.get("focus")).toBe("password");
    expect(JSON.stringify(logEvent.mock.calls)).toContain('"method":"recovery"');
  });

  it("sends an expired recovery link to the login page", async () => {
    verifyOtp.mockResolvedValue({ data: { user: null }, error: { code: "otp_expired" } });
    const res = await call(`token_hash=${hash}&type=recovery&locale=de&next=${next}`);
    expect(loc(res).pathname).toBe("/de/login");
    expect(loc(res).searchParams.get("error")).toBe("link_invalid");
  });

  it("never leaves the origin via `next`", async () => {
    const res = await call(`token_hash=${hash}&type=recovery&locale=de&next=${encodeURIComponent("//evil.com")}`);
    expect(loc(res).origin).toBe(ORIGIN);
    expect(loc(res).pathname).toBe("/de/app");
  });
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

describe("GET /auth/confirm for invites", () => {
  it("verifies a token-hash invite link (custom template) and signs the user in", async () => {
    const res = await call(`token_hash=${hash}&type=invite&locale=de&invited=1`);
    expect(verifyOtp).toHaveBeenCalledWith({ type: "invite", token_hash: hash });
    expect(loc(res).pathname).toBe("/de/app");
  });

  it("default-template invite (session in the URL fragment): friendly login page, no error", async () => {
    const res = await call("locale=en&invited=1");
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(loc(res).pathname).toBe("/en/login");
    expect(loc(res).search).toBe("?invited=1");
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a plain bad query without the invite flag is still an error", async () => {
    const res = await call("locale=en");
    expect(loc(res).search).toBe("?error=link_invalid");
  });
});
