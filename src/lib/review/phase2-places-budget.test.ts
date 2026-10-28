// Overpass time budget: places requests run in /api/trips/[id]/places (maxDuration 300 s, budget 280 s).
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

import { OVERPASS_CLIENT_TIMEOUT_MS } from "@/lib/integrations/overpass";
import { VIEW_BUDGET_MS, getPlacesFacts } from "@/lib/server/facts/places";

const MAX_DURATION_MS = 300_000;
/** MAX_INTEREST_QUERIES caps OSM interests per trip at 4. */
const FOUR = ["golf", "beach", "museums", "hiking"];
const trip = {
  id: "t", lengthDays: 5, groupId: null, purposeId: "p", wantsFlights: false, originAirports: [], createdAt: "", updatedAt: "",
  timing: { kind: "none" as const },
  destination: { kind: "region" as const, name: "x", placeName: "x", geoId: 1, countryCode: "ES", admin1: null, lat: 36.5, lon: -4.9, timezone: "Europe/Madrid", radiusKm: 40 },
};
const purpose = (interests: string[]) => ({ id: "p", name: "p", guided: { interests }, constraints: [], tags: null, createdAt: "", updatedAt: "" });
const ctx = { userId: null, locale: "de" as const, today: "2026-10-28" };

async function run(durations: number[], interests: string[]) {
  timeline.durations = durations;
  const started = Date.now();
  const p = getPlacesFacts(trip as never, purpose(interests) as never, ctx);
  await vi.advanceTimersByTimeAsync(1_000_000);
  const fact = await p;
  return { fact, starts: timeline.starts.map((t) => t - started) };
}

describe("places: Overpass time budget vs maxDuration = 300 s", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    timeline.durations = [];
    timeline.starts = [];
    timeline.i = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("budget plus margin fits into maxDuration", () => {
    expect(VIEW_BUDGET_MS).toBeLessThan(MAX_DURATION_MS);
  });

  it("no query starts unless it can finish (start + client timeout <= budget)", async () => {
    const { starts } = await run([90_000, 90_000, 90_000, 90_000], FOUR);
    expect(starts).toHaveLength(3); // starts at 0, 90, 180 s; a 4th at 270 s could not finish within 280 s
    for (const s of starts.slice(1)) expect(s + OVERPASS_CLIENT_TIMEOUT_MS).toBeLessThanOrEqual(VIEW_BUDGET_MS);
    expect(starts.at(-1)! + OVERPASS_CLIENT_TIMEOUT_MS).toBeLessThanOrEqual(MAX_DURATION_MS);
  });

  it("interests that did not fit are reported as error groups (fetched on the next request), not dropped", async () => {
    const { fact, starts } = await run([90_000, 90_000, 90_000, 90_000], FOUR);
    expect(fact.status).toBe("ok");
    if (fact.status !== "ok") return;
    expect(fact.data.groups).toHaveLength(4);
    expect(fact.data.groups.filter((g) => g.status === "error")).toHaveLength(4 - starts.length);
  });

  it("fast (cached) queries all run in one request", async () => {
    const { starts } = await run([0, 0, 0, 0], FOUR);
    expect(starts).toHaveLength(4);
  });
});
