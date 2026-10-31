import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  cached: vi.fn(),
  peek: vi.fn(),
  rows: {} as Record<string, unknown>,
  fetchCalls: 0,
}));
vi.mock("../api-cache", () => ({
  cached: state.cached,
  peekCache: state.peek,
  cacheKey: (e: string, v: number, p: Record<string, string | number>) =>
    `${e}:v${v}:${Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join(";")}`,
}));
vi.mock("../supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.rows[table] ?? null, error: null }) }),
      }),
    }),
  }),
}));

import type { FactsCtx } from "@/lib/domain/facts";
import type { Trip } from "@/lib/domain/trip";

const { getDestinationPicture, getSharedDestinationPicture } = await import("./picture");
const { hashShareToken } = await import("../share-token");

const ctx: FactsCtx = { userId: "u1", locale: "de", today: "2026-10-31" };
const base = { id: "t1", lengthDays: 7, groupId: null, purposeId: null, wantsFlights: false, originAirports: [], createdAt: "", updatedAt: "" };
const passau: Trip = {
  ...base,
  timing: { kind: "none" },
  destination: { kind: "city", name: "Passau", placeName: "Passau", geoId: 2855328, countryCode: "DE", admin1: "Bayern", lat: 48.5665, lon: 13.43122, timezone: "Europe/Berlin", radiusKm: 15 },
};
const free: Trip = { ...base, timing: { kind: "none" }, destination: { kind: "freetext", name: "Irgendwo", countryCode: undefined as never } };
const picture = {
  url: "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Passau-banner-s1.jpg/1920px-Passau-banner-s1.jpg",
  width: 1920,
  height: 275,
  author: "Traveler100",
  licenseName: "CC BY-SA 3.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0",
  sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Passau-banner-s1.jpg",
  kind: "banner",
  title: "Passau-banner-s1.jpg",
};
const token = "A".repeat(43);

beforeEach(() => {
  state.cached.mockReset();
  state.peek.mockReset();
  state.rows = {};
});

describe("getDestinationPicture", () => {
  it("returns the cached picture with its check date; one language-independent key per geo id, 60 day TTL", async () => {
    state.cached.mockResolvedValue({ ok: true, data: picture, fetchedAt: "2026-10-31T10:00:00.000Z", stale: false, cache: "hit" });
    const r = await getDestinationPicture(passau, ctx);
    expect(r).toEqual({ ...picture, fetchedAt: "2026-10-31T10:00:00.000Z" });
    expect(state.cached.mock.calls[0][0]).toMatchObject({
      provider: "wikidata",
      endpoint: "picture",
      key: "picture:v1:geo=2855328",
      ttlSeconds: 60 * 86400,
    });
  });
  it("returns null for a cached negative result, a provider failure, a freetext destination and a thrown error", async () => {
    state.cached.mockResolvedValue({ ok: true, data: null, fetchedAt: "x", stale: false, cache: "hit" });
    expect(await getDestinationPicture(passau, ctx)).toBeNull();
    state.cached.mockResolvedValue({ ok: false, error: "timeout" });
    expect(await getDestinationPicture(passau, ctx)).toBeNull();
    state.cached.mockClear();
    expect(await getDestinationPicture(free, ctx)).toBeNull();
    expect(state.cached).not.toHaveBeenCalled();
    state.cached.mockRejectedValue(new Error("boom"));
    expect(await getDestinationPicture(passau, ctx)).toBeNull();
  });
});

describe("getSharedDestinationPicture (public path: cache only)", () => {
  const shared = (over: Record<string, unknown> = {}) => ({
    share_links: { trip_id: "t1", owner_id: "o1", expires_at: null },
    profiles: { disabled_at: null },
    trips: { dest_kind: "city", dest_geo_id: 2855328, dest_name: "Passau" },
    ...over,
  });
  it("reads the same cache key without calling cached() (no external call)", async () => {
    state.rows = shared();
    state.peek.mockResolvedValue({ data: picture, fetchedAt: "2026-10-31T10:00:00.000Z" });
    expect(await getSharedDestinationPicture(token, "Passau")).toEqual({ ...picture, fetchedAt: "2026-10-31T10:00:00.000Z" });
    expect(state.peek.mock.calls[0][0]).toMatchObject({ provider: "wikidata", key: "picture:v1:geo=2855328" });
    expect(state.cached).not.toHaveBeenCalled();
    expect(hashShareToken(token)).toHaveLength(64);
  });
  it("returns null for an expired link and a disabled or missing owner, even with a cache hit", async () => {
    state.peek.mockResolvedValue({ data: picture, fetchedAt: "2026-10-31T10:00:00.000Z" });
    state.rows = shared({ share_links: { trip_id: "t1", owner_id: "o1", expires_at: "2020-01-01T00:00:00.000Z" } });
    expect(await getSharedDestinationPicture(token, "Passau")).toBeNull();
    state.rows = shared({ profiles: { disabled_at: "2026-10-31T10:00:00.000Z" } });
    expect(await getSharedDestinationPicture(token, "Passau")).toBeNull();
    state.rows = shared({ profiles: undefined });
    expect(await getSharedDestinationPicture(token, "Passau")).toBeNull();
    state.rows = shared({ share_links: { trip_id: "t1", owner_id: "o1", expires_at: "2099-01-01T00:00:00.000Z" } });
    expect(await getSharedDestinationPicture(token, "Passau")).not.toBeNull();
  });
  it("shows no picture when the destination changed since the shared plan was made", async () => {
    state.peek.mockResolvedValue({ data: picture, fetchedAt: "2026-10-31T10:00:00.000Z" });
    state.rows = shared();
    expect(await getSharedDestinationPicture(token, "Wien")).toBeNull();
    expect(state.peek).not.toHaveBeenCalled();
  });
  it("returns null on cache miss, freetext trips, unknown link and malformed token", async () => {
    state.rows = shared();
    state.peek.mockResolvedValue(undefined);
    expect(await getSharedDestinationPicture(token, "Passau")).toBeNull();
    state.rows = shared({ trips: { dest_kind: "freetext", dest_geo_id: null } });
    expect(await getSharedDestinationPicture(token, "Passau")).toBeNull();
    state.rows = {};
    expect(await getSharedDestinationPicture(token, "Passau")).toBeNull();
    expect(await getSharedDestinationPicture("short", "Passau")).toBeNull();
  });
});
