import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  rpc: vi.fn(),
  batch: vi.fn(),
  logEvent: vi.fn(),
  after: vi.fn(),
  landmarks: vi.fn(),
}));

function fake() {
  return {
    from: (table: string) => {
      const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: h.rows[table] ?? null, error: null }) };
      return b;
    },
    rpc: h.rpc,
  };
}
vi.mock("next/server", () => ({ after: h.after }));
vi.mock("../supabase/admin", () => ({ createSupabaseAdminClient: () => fake() }));
vi.mock("./fetch", () => ({ fetchStopInfoBatch: h.batch }));
vi.mock("../events", () => ({ logEvent: h.logEvent }));
vi.mock("../tour/landmarks", () => ({ readLandmarks: h.landmarks }));

import { BACKGROUND_BUDGET_MS, landmarkQids, prefetchStopInfo, resetPrefetchState, scheduleStopInfoPrefetch } from "./prefetch";

const TOUR = "55555555-5555-4555-8555-555555555555";
const city = { key: "geo:1", name: "London", lat: 51.5072, lon: -0.1276, source: "geonames" };
const input = {
  city,
  places: [
    { key: "osm:w1", name: "Hyde Park", lat: 51.507, lon: -0.165, source: "osm" },
    { key: "osm:w2", name: "Buckingham Palace", lat: 51.501, lon: -0.142, source: "osm" },
  ],
};
const NOW = Date.parse("2026-11-15T10:00:00Z");
const fresh = new Date(NOW - 1000).toISOString();
const card = (key: string, extra = {}) => ({ key, status: "ok", checkedAt: fresh, storedAt: fresh, ...extra });

beforeEach(() => {
  resetPrefetchState();
  h.rows = { city_tours: { id: TOUR, owner_id: "owner", input, stop_info: null }, profiles: { locale: "en" } };
  h.rpc.mockReset().mockImplementation(async (name: string) => (name === "stop_info_reserve" ? { data: { ok: true, id: "slot1" }, error: null } : { data: "ok", error: null }));
  h.batch.mockReset().mockResolvedValue({ entries: [card("osm:w1"), card("osm:w2")], unfinished: [], calls: 4, storedAt: fresh });
  h.logEvent.mockReset();
  h.after.mockReset();
  h.landmarks.mockReset().mockResolvedValue({
    ranked: [{ osmType: "way", osmId: 1, wikidata: "Q1" }, { osmType: "node", osmId: 7, wikidata: "Q7" }],
  });
});

describe("scheduleStopInfoPrefetch", () => {
  it("runs the batch after the response, at most once per tour within the cooldown", () => {
    expect(scheduleStopInfoPrefetch(TOUR, NOW)).toBe(true);
    expect(scheduleStopInfoPrefetch(TOUR, NOW + 60_000)).toBe(true); // still loading, not scheduled again
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(scheduleStopInfoPrefetch(TOUR, NOW + 3 * 60_000)).toBe(true);
    expect(h.after).toHaveBeenCalledTimes(2);
  });

  it("outside a request scope (after() throws) nothing is scheduled", () => {
    h.after.mockImplementation(() => {
      throw new Error("no request scope");
    });
    expect(scheduleStopInfoPrefetch(TOUR, NOW)).toBe(false);
  });
});

describe("landmarkQids", () => {
  it("maps tour point keys to Wikidata ids from the city's cached landmarks (anchor = city)", async () => {
    const m = await landmarkQids(input as never, { userId: "owner" });
    expect(h.landmarks).toHaveBeenCalledWith({ lat: city.lat, lon: city.lon }, { userId: "owner" });
    expect(m.get("osm:w1")).toBe("Q1");
    expect(m.get("osm:n7")).toBe("Q7");
  });

  it("no cached set → empty map", async () => {
    h.landmarks.mockResolvedValue(null);
    expect((await landmarkQids(input as never, { userId: null })).size).toBe(0);
  });
});

describe("prefetchStopInfo", () => {
  it("fetches missing stops with the long budget, all OSM tags and the known ids; merges and settles", async () => {
    expect(await prefetchStopInfo(TOUR, () => NOW)).toBe("done");
    const [points, locale, ctx, clock, opts] = h.batch.mock.calls[0];
    expect(points.map((p: { key: string }) => p.key)).toEqual(["osm:w1", "osm:w2"]);
    expect(locale).toBe("en");
    expect(ctx).toEqual({ userId: "owner" });
    expect(clock.deadline).toBe(NOW + BACKGROUND_BUDGET_MS);
    expect(opts.tags).toBe("all");
    expect(opts.qids.get("osm:w1")).toBe("Q1");
    expect(h.rpc).toHaveBeenCalledWith("merge_stop_info", expect.objectContaining({ p_tour: TOUR, p_locale: "en" }));
    expect(h.rpc).toHaveBeenCalledWith("stop_info_settle", { p_id: "slot1" });
  });

  it("only missing or partial stops: fresh full cards are not fetched again; all fresh → no call at all", async () => {
    h.rows.city_tours = { id: TOUR, owner_id: "owner", input, stop_info: { v: 1, locale: "en", stops: [card("osm:w1"), card("osm:w2", { partial: true })] } };
    await prefetchStopInfo(TOUR, () => NOW);
    expect(h.batch.mock.calls[0][0].map((p: { key: string }) => p.key)).toEqual(["osm:w2"]);

    h.batch.mockClear();
    h.rpc.mockClear();
    h.rows.city_tours = { id: TOUR, owner_id: "owner", input, stop_info: { v: 1, locale: "en", stops: [card("osm:w1"), card("osm:w2")] } };
    expect(await prefetchStopInfo(TOUR, () => NOW)).toBe("nothing");
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled(); // no reservation either
  });

  it("daily limit used up → no batch", async () => {
    h.rpc.mockImplementation(async (name: string) => (name === "stop_info_reserve" ? { data: { ok: false }, error: null } : { data: "ok", error: null }));
    expect(await prefetchStopInfo(TOUR, () => NOW)).toBe("limited");
    expect(h.batch).not.toHaveBeenCalled();
  });

  it("a batch without network calls releases the slot; a thrown error is logged, never thrown", async () => {
    h.batch.mockResolvedValue({ entries: [], unfinished: ["osm:w1", "osm:w2"], calls: 0, storedAt: fresh });
    await prefetchStopInfo(TOUR, () => NOW);
    expect(h.rpc).toHaveBeenCalledWith("stop_info_release", { p_id: "slot1" });

    h.batch.mockRejectedValue(new Error("boom"));
    expect(await prefetchStopInfo(TOUR, () => NOW)).toBe("failed");
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "tour.stop_info_failed", level: "error" }));
  });
});
