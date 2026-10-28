import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip";

const h = (o: Record<string, string>) => new Headers(o);

describe("clientIp", () => {
  it("prefers the first x-forwarded-for entry", () => {
    expect(clientIp(h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2", "x-real-ip": "3.3.3.3" }))).toBe("1.1.1.1");
  });
  it("falls back to x-real-ip", () => {
    expect(clientIp(h({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
  });
  it("returns null without headers or with blank values", () => {
    expect(clientIp(h({}))).toBeNull();
    expect(clientIp(h({ "x-forwarded-for": " " }))).toBeNull();
  });
});
