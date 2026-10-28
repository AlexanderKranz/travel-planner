// QA review test: Overpass time budget vs maxDuration = 60 s. "KNOWN DEFECT" uses it.fails (green while the defect exists).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const timeline = vi.hoisted(() => ({ durations: [] as number[], starts: [] as number[], i: 0 }));
vi.mock("@/lib/server/api-cache", () => ({
  cacheKey: (e: string, v: number, p: Record<string, string | number>) => `${e}:v${v}:${JSON.stringify(p)}`,
  cached: async () => {
    timeline.starts.push(Date.now());
    await new Promise((r) => setTimeout(r, timeline.durations[timeline.i++] ?? 0));
    return { ok: true, data: [], fetchedAt: "2026-10-28T00:00:00.000Z", stale: false, cache: "miss" };
  },
}));

import { getPlacesFacts } from "@/lib/server/facts/places";

describe("places: Overpass time budget vs maxDuration = 60 s", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    timeline.durations = [];
    timeline.starts = [];
    timeline.i = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("a second query may start at 39 s and run 45 s, ending at 84 s > maxDuration 60 s", async () => {
    const trip = {
      id: "t", lengthDays: 5, groupId: null, purposeId: "p", wantsFlights: false, originAirports: [], createdAt: "", updatedAt: "",
      timing: { kind: "none" as const },
      destination: { kind: "region" as const, name: "x", placeName: "x", geoId: 1, countryCode: "ES", admin1: null, lat: 36.5, lon: -4.9, timezone: "Europe/Madrid", radiusKm: 40 },
    };
    const purpose = { id: "p", name: "p", guided: { interests: ["golf", "beach", "museums"] }, constraints: [], createdAt: "", updatedAt: "" };
    timeline.durations = [39_000, 45_000, 45_000]; // worst case allowed by VIEW_BUDGET_MS = 40 s and the 45 s client timeout
    const started = Date.now();
    const p = getPlacesFacts(trip as never, purpose as never, { userId: null, locale: "de", today: "2026-10-28" });
    await vi.advanceTimersByTimeAsync(200_000);
    await p;
    const last = timeline.starts.at(-1)! - started;
    // A query must not START if start + OVERPASS_CLIENT_TIMEOUT_MS (45 s) would exceed the 60 s function limit.
    expect(last + 45_000).toBeLessThanOrEqual(60_000);
  });
});
