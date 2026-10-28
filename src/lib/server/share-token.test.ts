import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { hashShareToken, isShareTokenFormat, newShareToken } from "./share-token";

describe("share token", () => {
  it("is 43 chars base64url and unique; hash is sha256 hex of it", () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(hashShareToken(a.token));
    expect(a.hash).not.toContain(a.token);
  });
  it("sha256 known vector", () => {
    expect(hashShareToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("format check", () => {
    expect(isShareTokenFormat(newShareToken().token)).toBe(true);
    for (const t of ["", "short", "a".repeat(44), "a".repeat(42) + "=", "a".repeat(42) + "/"]) {
      expect(isShareTokenFormat(t)).toBe(false);
    }
  });
});
