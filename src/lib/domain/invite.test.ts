import { describe, expect, it } from "vitest";
import { InviteInput, InviteRevokeInput, inviteStatus } from "./invite";

describe("invite domain", () => {
  it("normalises the email and requires a valid locale", () => {
    expect(InviteInput.parse({ email: "  Ana@Example.COM ", locale: "de" })).toEqual({ email: "ana@example.com", locale: "de" });
    expect(InviteInput.safeParse({ email: "nope", locale: "de" }).success).toBe(false);
    expect(InviteInput.safeParse({ email: "a@b.de", locale: "fr" }).success).toBe(false);
    expect(InviteInput.safeParse({ email: `${"a".repeat(250)}@b.de`, locale: "de" }).success).toBe(false);
  });
  it("revoke takes a positive integer id", () => {
    expect(InviteRevokeInput.safeParse({ id: 3 }).success).toBe(true);
    expect(InviteRevokeInput.safeParse({ id: 0 }).success).toBe(false);
    expect(InviteRevokeInput.safeParse({ id: "3" }).success).toBe(false);
  });
  it("status follows the first sign-in", () => {
    expect(inviteStatus(null)).toBe("pending");
    expect(inviteStatus(undefined)).toBe("pending");
    expect(inviteStatus("2026-11-01T10:00:00Z")).toBe("accepted");
  });
});
