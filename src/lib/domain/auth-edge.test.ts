import { describe, expect, it } from "vitest";
import { ConfirmQuery, LoginRequest, safeNextPath } from "./auth";

describe("safeNextPath edge cases", () => {
  const bad = [
    "//evil.com",
    "///evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "evil.com",
    "",
    "de/app",
  ];
  for (const value of bad) {
    it(`falls back for ${JSON.stringify(value)}`, () => {
      expect(safeNextPath(value, "/de/app")).toBe("/de/app");
    });
  }

  it("keeps query strings and nested paths", () => {
    expect(safeNextPath("/en/app/groups/1?tab=2", "/de/app")).toBe("/en/app/groups/1?tab=2");
  });

  // DEFECT (nit): the WHATWG URL parser strips tab/CR/LF, so "/\t/evil.com" becomes "//evil.com"
  // if a caller ever builds a Location header from the string directly. The confirm route
  // uses url.pathname on a cloned same-origin URL, so it is not exploitable today.
  // Flip to plain `it` once safeNextPath rejects control characters.
  it("rejects control characters that URL parsers strip", () => {
    expect(safeNextPath("/\t/evil.com", "/de/app")).toBe("/de/app");
    expect(safeNextPath("/\n/evil.com", "/de/app")).toBe("/de/app");
  });
});

describe("ConfirmQuery edge cases", () => {
  const base = { token_hash: "abcdefghijk", type: "email" };
  it("drops path-like or unknown locales instead of failing", () => {
    for (const locale of ["../evil", "DE", "de/../en", "//evil.com", "", "xx"]) {
      const parsed = ConfirmQuery.safeParse({ ...base, locale });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.locale).toBeUndefined();
    }
  });
  it("only accepts the OTP types the route handles", () => {
    for (const type of ["recovery", "email_change", "sms", ""]) {
      expect(ConfirmQuery.safeParse({ ...base, type }).success).toBe(false);
    }
    expect(ConfirmQuery.safeParse({ ...base, type: "invite" }).success).toBe(true); // admin invites (phase 6 hardening)
  });
  it("bounds token_hash length", () => {
    expect(ConfirmQuery.safeParse({ ...base, token_hash: "short" }).success).toBe(false);
    expect(ConfirmQuery.safeParse({ ...base, token_hash: "x".repeat(201) }).success).toBe(false);
  });
});

describe("LoginRequest edge cases", () => {
  it("rejects over-long and malformed addresses", () => {
    expect(LoginRequest.safeParse({ email: `${"a".repeat(250)}@b.de`, locale: "de" }).success).toBe(false);
    expect(LoginRequest.safeParse({ email: "a@b.de\nbcc:x@y.z", locale: "de" }).success).toBe(false);
    expect(LoginRequest.safeParse({ email: "", locale: "de" }).success).toBe(false);
  });
  it("lowercases so the allowlist check (lower(email)) matches", () => {
    expect(LoginRequest.parse({ email: "Alex@Example.COM", locale: "en" }).email).toBe("alex@example.com");
  });
});
