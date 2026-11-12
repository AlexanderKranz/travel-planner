import { describe, expect, it, vi } from "vitest";
import type { ExtractedStop, ItineraryExtractError, ItineraryExtractResult } from "@/lib/domain/itinerary";

vi.mock("@/lib/itinerary/parse", () => ({
  parseItinerary: (text: string) =>
    text.includes("TABLE")
      ? { usable: true, stops: [{ stop: { day: 1, place: "Passau" }, flags: [] }, { stop: { day: 2, sea: true }, flags: [] }] }
      : { usable: false, stops: [] },
}));
vi.mock("@/lib/itinerary/prefilter", () => ({ prefilterItinerary: (t: string) => t }));

import { checkFile, errorKey, extractFromSource, fitSize, hasTextLayer, MAX_FILE_BYTES } from "./itinerary-read";

const ctx = { startDate: null, lengthDays: 5 };
const stop: ExtractedStop = { stop: { day: 1, place: "Wien" }, flags: ["from_image"] };

describe("checkFile", () => {
  it("accepts pdf and web images, refuses heic and oversize", () => {
    expect(checkFile({ type: "application/pdf", size: 1000 })).toEqual({ ok: true, kind: "pdf" });
    expect(checkFile({ type: "image/jpeg", size: 1000 })).toEqual({ ok: true, kind: "image" });
    expect(checkFile({ type: "image/heic", size: 1000 })).toEqual({ ok: false, error: "unsupportedType" });
    expect(checkFile({ type: "image/png", size: MAX_FILE_BYTES + 1 })).toEqual({ ok: false, error: "tooLarge" });
  });
});

describe("hasTextLayer and fitSize", () => {
  it("needs 40 non-space characters per page on average", () => {
    expect(hasTextLayer(["a ".repeat(60), "b".repeat(30)])).toBe(true);
    expect(hasTextLayer(["short", "x"])).toBe(false);
    expect(hasTextLayer([])).toBe(false);
  });
  it("scales the long edge to 1568 and never enlarges", () => {
    expect(fitSize(3136, 1568)).toEqual({ width: 1568, height: 784 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe("errorKey", () => {
  it("maps every server error", () => {
    const all: Record<ItineraryExtractError, string> = {
      forbidden: "forbidden",
      invalid: "unreadable",
      failed: "unreadable",
      ai_off: "aiOff",
      demo: "aiOff",
      rate_limited: "limit",
      budget: "limit",
      no_stops: "noStops",
    };
    for (const [k, v] of Object.entries(all)) expect(errorKey(k as ItineraryExtractError)).toBe(v);
  });
});

describe("extractFromSource", () => {
  it("uses the parser without calling the server", async () => {
    const extract = vi.fn();
    const out = await extractFromSource({ kind: "text", text: "TABLE" }, ctx, extract);
    expect(out).toMatchObject({ ok: true, path: "parser" });
    expect(extract).not.toHaveBeenCalled();
  });

  it("falls back to the server text path on a parser miss", async () => {
    const extract = vi.fn(async (): Promise<ItineraryExtractResult> => ({ ok: true, path: "text_ai", stops: [stop] }));
    const out = await extractFromSource({ kind: "text", text: "prose" }, ctx, extract);
    expect(extract).toHaveBeenCalledWith({ kind: "text", text: "prose" });
    expect(out).toMatchObject({ ok: true, path: "text_ai" });
  });

  it("sends images straight to the server", async () => {
    const extract = vi.fn(async (): Promise<ItineraryExtractResult> => ({ ok: true, path: "image_ai", stops: [stop] }));
    await extractFromSource({ kind: "images", images: [{ mediaType: "image/jpeg", data: "AAAA" }] }, ctx, extract);
    expect(extract).toHaveBeenCalledOnce();
  });

  it("maps errors, an empty result and a thrown call", async () => {
    const src = { kind: "text" as const, text: "prose" };
    expect(await extractFromSource(src, ctx, async () => ({ ok: false, error: "ai_off" }))).toEqual({ ok: false, error: "aiOff" });
    expect(await extractFromSource(src, ctx, async () => ({ ok: true, path: "text_ai", stops: [] }))).toEqual({ ok: false, error: "noStops" });
    expect(await extractFromSource(src, ctx, async () => { throw new Error("x"); })).toEqual({ ok: false, error: "unreadable" });
    expect(await extractFromSource({ kind: "text", text: "  " }, ctx, vi.fn())).toEqual({ ok: false, error: "noStops" });
  });
});
