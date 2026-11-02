import { describe, expect, it } from "vitest";
import { buildFeedbackFormData, checkScreenshotInput, responseErrorKey, feedbackErrorKey, fitsServerLimit, fitWithin, parseKind, safeFromPath, textState } from "./feedback-client";

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

describe("hardening", () => {
  it("rejects backslash, scheme and control characters in from", () => {
    expect(safeFromPath("/\\evil")).toBeUndefined();
    expect(safeFromPath("javascript:alert(1)")).toBeUndefined();
    expect(safeFromPath("/app/x\ny")).toBeUndefined();
  });
  it("accepts an empty MIME type only with an image extension", () => {
    expect(checkScreenshotInput({ type: "", size: 10, name: "Screen.PNG" })).toBe("ok");
    expect(checkScreenshotInput({ type: "", size: 10, name: "notes.txt" })).toBe("bad_type");
    expect(checkScreenshotInput({ type: "", size: 10 })).toBe("bad_type");
  });
});

describe("responseErrorKey", () => {
  it("separates burst from daily limit by Retry-After", () => {
    expect(responseErrorKey(429, { ok: false, error: "rate_limited" }, "30")).toBe("rateLimitedBurst");
    expect(responseErrorKey(429, { ok: false, error: "rate_limited" }, null)).toBe("rateLimited");
  });
  it("maps 413 without JSON to tooLarge", () => {
    expect(responseErrorKey(413, null, null)).toBe("tooLarge");
    expect(responseErrorKey(500, null, null)).toBe("failed");
    expect(responseErrorKey(400, { ok: false, error: "bad_image" }, null)).toBe("badImage");
  });
});

describe("buildFeedbackFormData", () => {
  it("sends the expected fields", async () => {
    const shot = new Blob(["x"], { type: "image/webp" });
    const fd = buildFeedbackFormData({ kind: "idea", text: "  hello world!  ", from: "/de/app/trips", viewport: 359.6, screenshot: shot });
    expect(fd.get("kind")).toBe("idea");
    expect(fd.get("text")).toBe("hello world!");
    expect(fd.get("pagePath")).toBe("/de/app/trips");
    expect(fd.get("viewport")).toBe("360");
    const f = fd.get("screenshot") as File;
    expect(f.name).toBe("screenshot.webp");
    expect(f.type).toBe("image/webp");
  });
  it("omits the screenshot when none", () => {
    expect(buildFeedbackFormData({ kind: "bug", text: "abcdefghij", viewport: 400 }).has("screenshot")).toBe(false);
  });
});
