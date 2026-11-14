import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown> | null;
const h = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  rpc: vi.fn(),
  batch: vi.fn(),
  logEvent: vi.fn(),
  session: { userId: "viewer" } as { userId: string } | null,
}));

/** Minimal chainable fake: from(table).select().eq()…maybeSingle() answers h.rows[table]. */
function fake() {
  return {
    from: (table: string) => {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: (h.rows[table] ?? null) as Row, error: null }),
      };
      return b;
    },
    rpc: h.rpc,
  };
}
vi.mock("../session", () => ({ getUserSession: async () => (h.session ? { ...h.session, supabase: fake() } : null) }));
vi.mock("../supabase/admin", () => ({ createSupabaseAdminClient: () => fake() }));
vi.mock("./fetch", () => ({ fetchStopInfoBatch: h.batch }));
vi.mock("../events", () => ({ logEvent: h.logEvent }));

import { resetRateLimits } from "../rate-limit";
import { getSharedTourStopInfo, getTourStopInfo } from "./actions";

const TOUR = "44444444-4444-4444-8444-444444444444";
const input = {
  places: [
    { key: "osm:w1", name: "Dom", lat: 48.2, lon: 16.37, source: "osm" },
    { key: "osm:n2", name: "Prater", lat: 48.21, lon: 16.39, source: "osm" },
  ],
};
const fresh = new Date().toISOString();
const entry = (key: string) => ({ key, status: "none", checkedAt: fresh });

beforeEach(() => {
  resetRateLimits();
  h.session = { userId: "viewer" };
  h.rows = { city_tours: { id: TOUR, owner_id: "owner", input, stop_info: null }, profiles: { locale: "de", disabled_at: null } };
  h.rpc.mockReset().mockImplementation(async (name: string) => (name === "stop_info_reserve" ? { data: { ok: true, id: "slot1" }, error: null } : { data: "ok", error: null }));
  h.batch.mockReset().mockResolvedValue({ entries: [entry("osm:w1"), entry("osm:n2")], unfinished: [], calls: 3 });
  h.logEvent.mockReset();
});

describe("getTourStopInfo", () => {
  it("everything stored and fresh → no reservation, no batch", async () => {
    h.rows.city_tours = { id: TOUR, owner_id: "owner", input, stop_info: { v: 1, locale: "de", stops: [entry("osm:w1"), entry("osm:n2")] } };
    const r = await getTourStopInfo(TOUR);
    expect(r).toMatchObject({ ok: true, data: { pending: [], limited: false } });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.batch).not.toHaveBeenCalled();
  });

  it("pending stops → reserve, one batch for all of them, atomic merge, settle (requests were sent)", async () => {
    await getTourStopInfo(TOUR);
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(["stop_info_reserve", "merge_stop_info", "stop_info_settle"]);
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_user: "viewer", p_link: null, p_scope_limit: 60, p_app_limit: 2000 });
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect(h.batch.mock.calls[0][0].map((p: { key: string }) => p.key)).toEqual(["osm:w1", "osm:n2"]);
    expect(h.batch.mock.calls[0][1]).toBe("de");
    expect(h.rpc.mock.calls[1][1]).toEqual({ p_tour: TOUR, p_locale: "de", p_entries: [entry("osm:w1"), entry("osm:n2")] });
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "tour.stop_info", props: expect.objectContaining({ via: "session", calls: 3 }) }));
  });

  it("a batch served fully from the cache gives the slot back", async () => {
    h.batch.mockResolvedValue({ entries: [entry("osm:w1")], unfinished: [], calls: 0 });
    await getTourStopInfo(TOUR);
    expect(h.rpc.mock.calls.at(-1)?.[0]).toBe("stop_info_release");
  });

  it("daily limit used up → cache-only batch (offline clock), no slot to settle, marked limited", async () => {
    h.rpc.mockImplementation(async (name: string) => (name === "stop_info_reserve" ? { data: { ok: false, reason: "scope" }, error: null } : { data: "ok", error: null }));
    h.batch.mockResolvedValue({ entries: [], unfinished: ["osm:w1", "osm:n2"], calls: 0, storedAt: fresh });
    const r = await getTourStopInfo(TOUR);
    expect(r).toMatchObject({ ok: true, data: { limited: true, pending: ["osm:w1", "osm:n2"] } });
    expect(h.batch.mock.calls[0][3]).toMatchObject({ offline: true });
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(["stop_info_reserve"]);
  });

  it("a failing merge is logged and the slot settled; the viewer still gets the stored view", async () => {
    h.rpc.mockImplementation(async (name: string) =>
      name === "stop_info_reserve" ? { data: { ok: true, id: "slot1" }, error: null } : name === "merge_stop_info" ? { data: null, error: { message: "boom" } } : { data: "ok", error: null },
    );
    const r = await getTourStopInfo(TOUR);
    expect(r.ok).toBe(true);
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "tour.stop_info_failed", level: "error" }));
    expect(h.rpc.mock.calls.at(-1)?.[0]).toBe("stop_info_settle");
  });

  it("not signed in, bad id, unreadable tour", async () => {
    h.session = null;
    expect(await getTourStopInfo(TOUR)).toEqual({ ok: false, error: "unauthenticated" });
    h.session = { userId: "viewer" };
    expect(await getTourStopInfo("x")).toEqual({ ok: false, error: "invalid" });
    h.rows.city_tours = null;
    expect(await getTourStopInfo(TOUR)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("getSharedTourStopInfo", () => {
  const token = "a".repeat(43);

  it("rejects malformed tokens and expired links without any read", async () => {
    expect(await getSharedTourStopInfo("short", TOUR)).toEqual({ ok: false, error: "not_found" });
    h.rows.share_links = { id: "l1", owner_id: "owner", trip_id: "t1", expires_at: "2000-01-01T00:00:00Z" };
    expect(await getSharedTourStopInfo(token, TOUR)).toEqual({ ok: false, error: "not_found" });
    expect(h.batch).not.toHaveBeenCalled();
  });

  it("a valid link fetches with the link's own limit (30), no user", async () => {
    h.rows.share_links = { id: "l1", owner_id: "owner", trip_id: "t1", expires_at: null };
    const r = await getSharedTourStopInfo(token, TOUR);
    expect(r.ok).toBe(true);
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_user: null, p_link: "l1", p_scope_limit: 30 });
    expect(h.batch.mock.calls[0][2]).toEqual({ userId: null });
  });
});
