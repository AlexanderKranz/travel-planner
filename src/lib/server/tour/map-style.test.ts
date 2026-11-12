import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { OPENFREEMAP_STYLE_URL, tourMapStyleUrl } from "./map-style";

describe("tourMapStyleUrl", () => {
  it("defaults to OpenFreeMap, can be switched off or replaced by an https style", () => {
    expect(tourMapStyleUrl({})).toBe(OPENFREEMAP_STYLE_URL);
    expect(OPENFREEMAP_STYLE_URL.startsWith("https://tiles.openfreemap.org/styles/")).toBe(true);
    expect(tourMapStyleUrl({ TOUR_MAP_STYLE_URL: "off" })).toBeNull();
    expect(tourMapStyleUrl({ TOUR_MAP_STYLE_URL: "https://tiles.openfreemap.org/styles/liberty" })).toBe("https://tiles.openfreemap.org/styles/liberty");
    expect(tourMapStyleUrl({ TOUR_MAP_STYLE_URL: "http://example.invalid/style.json" })).toBe(OPENFREEMAP_STYLE_URL);
  });
});
