import { describe, expect, it } from "vitest";
import { checkScreenshotInput, feedbackErrorKey, fitsServerLimit, fitWithin, parseKind, safeFromPath, textState } from "./feedback-client";

describe("fitWithin", () => {
  it("keeps small images", () => expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 }));
  it("scales the long edge to 1600", () => {
    expect(fitWithin(3200, 1600)).toEqual({ width: 1600, height: 800 });
    expect(fitWithin(1200, 4800)).toEqual({ width: 400, height: 1600 });
  });
  it("never returns zero", () => expect(fitWithin(10000, 1)).toEqual({ width: 1600, height: 1 }));
});

describe("checkScreenshotInput", () => {
  it("accepts png/jpeg/webp", () => expect(checkScreenshotInput({ type: "image/png", size: 100 })).toBe("ok"));
  it("rejects other types", () => expect(checkScreenshotInput({ type: "image/gif", size: 100 })).toBe("bad_type"));
  it("rejects huge files", () => expect(checkScreenshotInput({ type: "image/jpeg", size: 30_000_000 })).toBe("too_big_input"));
});

describe("fitsServerLimit", () => {
  it("is limited to 2 MB", () => {
    expect(fitsServerLimit(2 * 1024 * 1024)).toBe(true);
    expect(fitsServerLimit(2 * 1024 * 1024 + 1)).toBe(false);
    expect(fitsServerLimit(0)).toBe(false);
  });
});

describe("textState", () => {
  it("uses the trimmed length", () => {
    expect(textState("   ")).toBe("empty");
    expect(textState("  short  ")).toBe("short");
    expect(textState("long enough text")).toBe("ok");
    expect(textState("x".repeat(4001))).toBe("long");
  });
});

describe("feedbackErrorKey", () => {
  it("maps every server code", () => {
    expect(feedbackErrorKey("rate_limited")).toBe("rateLimited");
    expect(feedbackErrorKey("demo_forbidden")).toBe("demoForbidden");
    expect(feedbackErrorKey("too_large")).toBe("tooLarge");
    expect(feedbackErrorKey("bad_image")).toBe("badImage");
    expect(feedbackErrorKey("invalid")).toBe("invalid");
    expect(feedbackErrorKey("unauthenticated")).toBe("unauthenticated");
  });
  it("falls back to failed", () => {
    expect(feedbackErrorKey("whatever")).toBe("failed");
    expect(feedbackErrorKey(undefined)).toBe("failed");
  });
});

describe("safeFromPath / parseKind", () => {
  it("accepts plain paths only", () => {
    expect(safeFromPath("/app/trips")).toBe("/app/trips");
    expect(safeFromPath("//evil.com")).toBeUndefined();
    expect(safeFromPath("https://evil.com")).toBeUndefined();
    expect(safeFromPath(undefined)).toBeUndefined();
  });
  it("defaults to bug", () => {
    expect(parseKind("idea")).toBe("idea");
    expect(parseKind("x")).toBe("bug");
    expect(parseKind(undefined)).toBe("bug");
  });
});
