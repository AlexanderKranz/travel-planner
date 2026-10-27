import { describe, expect, it } from "vitest";
import { ConfirmQuery, LoginRequest, VerifyCodeInput, safeNextPath } from "./auth";

describe("safeNextPath", () => {
  it("allows relative paths and blocks open redirects", () => {
    expect(safeNextPath("/de/app", "/de")).toBe("/de/app");
    expect(safeNextPath("//evil.com", "/de")).toBe("/de");
    expect(safeNextPath("https://evil.com", "/de")).toBe("/de");
    expect(safeNextPath("/\\evil.com", "/de")).toBe("/de");
    expect(safeNextPath(undefined, "/de")).toBe("/de");
  });
});

describe("auth inputs", () => {
  it("normalizes email and validates locale", () => {
    expect(LoginRequest.parse({ email: " A@B.de ", locale: "de" }).email).toBe("a@b.de");
    expect(LoginRequest.safeParse({ email: "nope", locale: "de" }).success).toBe(false);
    expect(LoginRequest.safeParse({ email: "a@b.de", locale: "xx" }).success).toBe(false);
  });
  it("requires a 6-digit code", () => {
    expect(VerifyCodeInput.safeParse({ email: "a@b.de", code: "123456", locale: "en" }).success).toBe(true);
    expect(VerifyCodeInput.safeParse({ email: "a@b.de", code: "12345", locale: "en" }).success).toBe(false);
  });
  it("ignores an invalid locale in the confirm query", () => {
    const parsed = ConfirmQuery.parse({ token_hash: "abcdefghijk", type: "email", locale: "zz" });
    expect(parsed.locale).toBeUndefined();
  });
});
