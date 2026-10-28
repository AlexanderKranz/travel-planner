// Overpass time budget: places requests run in /api/trips/[id]/places (maxDuration 300 s, budget 280 s).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const timeline = vi.hoisted(() => ({ durations: [] as number[], starts: [] as number[], i: 0, hits: new Set<number>(), calls: 0 }));
vi.mock("@/lib/server/api-cache", () => ({
  cacheKey: (e: string, v: number, p: Record<string, string | number>) => `${e}:v${v}:${JSON.stringify(p)}`,
  // Like cached(): a hit never consults the budget; a miss asks fetchAllowed() before the network call.
  cached: async (o: { fetchAllowed?: () => boolean }) => {
    const n = timeline.calls++;
    const ok = { ok: true, data: [], fetchedAt: "2026-10-28T00:00:00.000Z", stale: false };
    if (timeline.hits.has(n)) return { ...ok, cache: "hit" };
    if (o.fetchAllowed && !o.fetchAllowed()) return { ok: false, error: "timeout" };
    timeline.starts.push(Date.now());
    await new Promise((r) => setTimeout(r, timeline.durations[timeline.i++] ?? 0));
    return { ...ok, cache: "miss" };
  },
}));

import { OVERPASS_CLIENT_TIMEOUT_MS } from "@/lib/integrations/overpass";
import { MIN_QUERY_WINDOW_MS, VIEW_BUDGET_MS, getPlacesFacts } from "@/lib/server/facts/places";

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

async function run(durations: number[], interests: string[], budgetMs?: number) {
  timeline.durations = durations;
  const started = Date.now();
  const p = getPlacesFacts(trip as never, purpose(interests) as never, ctx, budgetMs ? { budgetMs } : {});
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
    timeline.calls = 0;
    timeline.hits = new Set();
  });
  afterEach(() => vi.useRealTimers());

  it("budget plus margin fits into maxDuration", () => {
    expect(VIEW_BUDGET_MS).toBeLessThan(MAX_DURATION_MS);
  });

  it("a further query starts only with MIN_QUERY_WINDOW_MS left; every query is cut at the deadline", async () => {
    const { starts } = await run([90_000, 90_000, 90_000, 90_000], FOUR);
    expect(starts).toHaveLength(3); // starts at 0, 90, 180 s; at 270 s only 10 s would be left
    for (const s of starts.slice(1)) expect(VIEW_BUDGET_MS - s).toBeGreaterThanOrEqual(MIN_QUERY_WINDOW_MS);
    // runQuery caps each attempt at min(client timeout, deadline - now), so the request ends by the budget.
    for (const s of starts) expect(s + Math.min(OVERPASS_CLIENT_TIMEOUT_MS, VIEW_BUDGET_MS - s)).toBeLessThanOrEqual(MAX_DURATION_MS);
  });

  it("cached interests are served even when the budget is used up (plan pipeline, 110 s)", async () => {
    timeline.hits = new Set([2, 3]);
    const { fact, starts } = await run([100_000, 100_000], FOUR, 110_000);
    expect(starts).toHaveLength(1); // 2nd miss at 100 s: 10 s left
    if (fact.status !== "ok") throw new Error("not ok");
    expect(fact.data.groups.map((g) => g.status)).toEqual(["empty", "error", "empty", "empty"]);
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
