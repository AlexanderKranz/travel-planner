import { describe, expect, it } from "vitest";
import { activeLinks } from "./share";

describe("activeLinks", () => {
  it("counts links without expiry and links that expire after now", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    const links = [
      { expiresAt: null },
      { expiresAt: "2026-11-17T00:00:00Z" },
      { expiresAt: "2026-11-16T11:59:59Z" },
    ];
    expect(activeLinks(links, now)).toEqual({ now, active: 2 });
    expect(activeLinks([], now).active).toBe(0);
  });
});
