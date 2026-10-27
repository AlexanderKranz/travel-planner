import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getAppUrl } from "./app-url";

describe("getAppUrl", () => {
  it("prefers APP_URL and normalises to the origin", () => {
    expect(getAppUrl({ APP_URL: "https://plan.example.com/", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app" })).toBe("https://plan.example.com");
  });
  it("uses the Vercel production domain on production", () => {
    expect(getAppUrl({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app" })).toBe("https://x.vercel.app");
  });
  it("ignores the Vercel domain on preview", () => {
    expect(getAppUrl({ VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app", NODE_ENV: "production" })).toBeNull();
  });
  it("falls back to localhost in development", () => {
    expect(getAppUrl({ NODE_ENV: "development" })).toBe("http://localhost:3000");
  });
  it("returns null when nothing is configured", () => {
    expect(getAppUrl({ NODE_ENV: "production" })).toBeNull();
  });
  it("ignores an invalid or non-http APP_URL", () => {
    expect(getAppUrl({ APP_URL: "javascript:alert(1)", NODE_ENV: "development" })).toBe("http://localhost:3000");
    expect(getAppUrl({ APP_URL: "not a url", NODE_ENV: "production" })).toBeNull();
  });
});
