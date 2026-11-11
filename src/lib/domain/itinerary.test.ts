import { describe, expect, it } from "vitest";
import { ItineraryExtractInput, MAX_ITINERARY_IMAGE_B64, MAX_ITINERARY_TOTAL_B64 } from "./itinerary";

const img = (len: number) => ({ mediaType: "image/jpeg" as const, data: "a".repeat(len) });

describe("ItineraryExtractInput", () => {
  it("accepts images within the per-image and per-request budget", () => {
    const per = Math.floor(MAX_ITINERARY_TOTAL_B64 / 3);
    expect(ItineraryExtractInput.safeParse({ kind: "images", images: [img(per), img(per), img(per)] }).success).toBe(true);
  });

  it("refuses images that are each allowed but too large together (Vercel's 4.5 MB body limit)", () => {
    const each = MAX_ITINERARY_IMAGE_B64;
    expect(each * 2).toBeGreaterThan(MAX_ITINERARY_TOTAL_B64);
    expect(ItineraryExtractInput.safeParse({ kind: "images", images: [img(each), img(each)] }).success).toBe(false);
  });
});
