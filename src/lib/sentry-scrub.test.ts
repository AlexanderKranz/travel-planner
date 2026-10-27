import { describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubEvent, scrubString } from "./sentry-scrub";

describe("scrubString", () => {
  it("removes email addresses", () => {
    expect(scrubString("failed for anna.k+x@web.de today")).toBe("failed for [email] today");
  });
  it("removes encoded emails", () => {
    expect(scrubString("/x?foo=anna%40web.de")).not.toContain("anna");
  });
  it("redacts token query params", () => {
    const out = scrubString(
      "https://a.app/auth/confirm?token_hash=abc123&type=magiclink&code=xyz&next=/de",
    );
    expect(out).toContain("token_hash=[redacted]");
    expect(out).toContain("code=[redacted]");
    expect(out).toContain("type=magiclink");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("xyz");
  });
  it("redacts access_token in a fragment-like string", () => {
    expect(scrubString("#access_token=eyJabc&x=1")).not.toContain("eyJabc");
  });
  it("redacts bearer tokens and JWTs", () => {
    expect(scrubString("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer [redacted]");
    expect(scrubString("jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig_nature end")).toBe(
      "jwt [redacted] end",
    );
  });
  it("leaves harmless text alone", () => {
    expect(scrubString("Trip to Málaga, 5 days")).toBe("Trip to Málaga, 5 days");
  });
});

describe("scrubEvent", () => {
  const event = {
    message: "Login failed for bob@example.com",
    user: { id: "uuid-1", email: "bob@example.com", username: "bob", ip_address: "1.2.3.4" },
    request: {
      url: "https://a.app/auth/confirm?token_hash=secret1&code=secret2",
      query_string: "token_hash=secret1&code=secret2",
      cookies: { "sb-access-token": "c" },
      data: { password: "hunter2", email: "bob@example.com" },
      headers: { Authorization: "Bearer zzz", cookie: "a=b", "user-agent": "UA", apikey: "k" },
    },
    breadcrumbs: [
      { message: "fetch /auth?code=abc", data: { url: "/x?token_hash=t", email: "b@c.de" } },
    ],
    extra: { password: "p", note: "mail me at a@b.co" },
  };

  const out = scrubEvent(event);
  const json = JSON.stringify(out);

  it("leaves no secrets or emails anywhere", () => {
    for (const s of ["secret1", "secret2", "hunter2", "bob@", "zzz", "a=b", "b@c.de", "a@b.co", "abc", "1.2.3.4"]) {
      expect(json).not.toContain(s);
    }
  });
  it("keeps only the user id", () => {
    expect(out.user).toEqual({ id: "uuid-1" });
  });
  it("drops request data and cookies, keeps harmless headers", () => {
    expect(out.request).not.toHaveProperty("data");
    expect(out.request).not.toHaveProperty("cookies");
    expect(out.request.headers["user-agent"]).toBe("UA");
    expect(out.request.headers.Authorization).toBe("[redacted]");
  });
  it("does not mutate the input", () => {
    expect(event.user.email).toBe("bob@example.com");
  });
  it("handles events with no request or user", () => {
    expect(scrubEvent({ message: "x" })).toEqual({ message: "x" });
  });
});

describe("scrubBreadcrumb", () => {
  it("scrubs url and data", () => {
    const b = scrubBreadcrumb({ category: "navigation", data: { to: "/de?code=abc", from: "/" } });
    expect(JSON.stringify(b)).not.toContain("abc");
  });
});
