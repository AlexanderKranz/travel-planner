import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ adminCount: { count: 3 as number | null, error: null as unknown } }));
vi.mock("../supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte"]) q[m] = () => q;
      q.then = (res: (v: unknown) => unknown) => res(h.adminCount);
      return q;
    },
  }),
}));

import {
  claimRound1,
  claimRound2,
  countRunsToday,
  expireStaleRuns,
  failRound,
  finishRound,
  isExpired,
  isFresh,
  pruneSearches,
  rowToSearch,
  SEARCH_LOCK_MS,
  type NewSearch,
  type SearchRow,
  type StoredSearch,
} from "./store";

/** A user-session client double: every call is recorded, every awaited chain pops the next programmed result. */
function fakeSb(results: unknown[]) {
  const calls: { table: string; ops: [string, unknown[]][] }[] = [];
  const queue = [...results];
  const sb = {
    from(table: string) {
      const call = { table, ops: [] as [string, unknown[]][] };
      calls.push(call);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "insert", "update", "delete", "eq", "neq", "lt", "in", "order", "range", "limit", "returns"]) {
        q[m] = (...args: unknown[]) => (call.ops.push([m, args]), q);
      }
      for (const m of ["single", "maybeSingle"]) q[m] = (...args: unknown[]) => (call.ops.push([m, args]), Promise.resolve(queue.shift()));
      q.then = (res: (v: unknown) => unknown) => res(queue.shift());
      return q;
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

const NOW = Date.parse("2026-11-01T12:00:00Z");
const row = (o: Partial<SearchRow> = {}): SearchRow => ({
  id: "s1",
  purpose_id: "p1",
  group_id: null,
  purpose_name: "Golf",
  locale: "de",
  months: [3],
  origins: ["FRA"],
  max_flight_hours: "3.0",
  radius_km: 2128,
  travel_mode: "flight",
  max_drive_hours: null,
  home_name: null,
  home_lat: null,
  home_lon: null,
  input_hash: "a".repeat(64),
  input: { v: 1, lang: "de" },
  status: "done",
  busy_until: null,
  rounds: 1,
  cards: [],
  drops: {},
  error_code: null,
  model: "claude-haiku-5-5",
  cost_micro_usd: 400,
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
  ...o,
});
const NEW: NewSearch = {
  purposeId: "p1",
  groupId: null,
  purposeName: "Golf",
  locale: "de",
  months: [3],
  origins: ["FRA"],
  maxFlightHours: 3,
  radiusKm: 2128,
  travelMode: "flight",
  maxDriveHours: null,
  home: null,
  inputHash: "b".repeat(64),
  input: { v: 1, lang: "de", purpose: { interests: [], custom: [], hard: [], soft: [] }, count: 8 },
  model: "claude-haiku-5-5",
};

describe("rowToSearch", () => {
  it("maps the row; numeric hours come back as a number; internals are kept for the server", () => {
    const s = rowToSearch(row());
    expect(s).toMatchObject({ id: "s1", maxFlightHours: 3, rounds: 1, status: "done", error: null, inputHash: "a".repeat(64), costMicroUsd: 400 });
    expect(s.input).toMatchObject({ v: 1 });
  });
  it("a running list whose lock ran out reads as failed, never as running forever", () => {
    const s = rowToSearch(row({ status: "running", busy_until: new Date(Date.now() - 1000).toISOString() }));
    expect(s).toMatchObject({ status: "failed", error: "failed" });
    expect(rowToSearch(row({ status: "running", busy_until: new Date(Date.now() + 60_000).toISOString() })).status).toBe("running");
  });
  it("unknown cards or drops read as empty instead of breaking the page; unknown error codes read as failed", () => {
    const s = rowToSearch(row({ cards: [{ nonsense: true }], drops: { "1": { bogus: 1 } }, status: "failed", error_code: "weird" }));
    expect(s.cards).toEqual([]);
    expect(s.drops).toEqual({});
    expect(s.error).toBe("failed");
    expect(rowToSearch(row({ status: "failed", error_code: "places_unavailable" })).error).toBe("places_unavailable");
  });
  it("rounds other than 2 read as 1", () => {
    expect(rowToSearch(row({ rounds: 2 })).rounds).toBe(2);
    expect(rowToSearch(row({ rounds: 7 })).rounds).toBe(1);
  });
});

describe("isFresh / isExpired", () => {
  it("done and updated within 30 days", () => {
    const day = 86_400_000;
    expect(isFresh({ status: "done", updatedAt: new Date(NOW - 29 * day).toISOString() }, NOW)).toBe(true);
    expect(isFresh({ status: "done", updatedAt: new Date(NOW - 31 * day).toISOString() }, NOW)).toBe(false);
    expect(isFresh({ status: "failed", updatedAt: new Date(NOW).toISOString() }, NOW)).toBe(false);
    expect(isFresh({ status: "running", updatedAt: new Date(NOW).toISOString() }, NOW)).toBe(false);
  });
  it("a missing or past lock is expired", () => {
    expect(isExpired(null, NOW)).toBe(true);
    expect(isExpired(new Date(NOW - 1).toISOString(), NOW)).toBe(true);
    expect(isExpired(new Date(NOW + 1000).toISOString(), NOW)).toBe(false);
  });
});

describe("expireStaleRuns", () => {
  it("reads the user's own lapsed running rows, then sets a killed first run to failed", async () => {
    const { sb, calls } = fakeSb([{ data: [{ id: "a", cards: [], rounds: 1 }], error: null }, { error: null }]);
    await expireStaleRuns(sb, NOW);
    expect(calls[0].ops).toContainEqual(["eq", ["status", "running"]]);
    expect(calls[0].ops).toContainEqual(["lt", ["busy_until", new Date(NOW).toISOString()]]);
    expect(calls[1].ops.find(([m]) => m === "update")![1][0]).toEqual({ status: "failed", busy_until: null, error_code: "failed" });
    expect(calls[1].ops).toContainEqual(["eq", ["id", "a"]]);
  });
  it("a killed 'Show others' (cards, round still 1) goes back to done, keeping its cards", async () => {
    const { sb, calls } = fakeSb([{ data: [{ id: "b", cards: [{ id: "g1" }], rounds: 1 }], error: null }, { error: null }]);
    await expireStaleRuns(sb, NOW);
    expect(calls[1].ops.find(([m]) => m === "update")![1][0]).toEqual({ status: "done", busy_until: null });
  });
  it("nothing lapsed: no update", async () => {
    const { sb, calls } = fakeSb([{ data: [], error: null }]);
    await expireStaleRuns(sb, NOW);
    expect(calls).toHaveLength(1);
  });
});

describe("claimRound1", () => {
  it("a new row: lock for 150 s, status running, hash on insert", async () => {
    const { sb, calls } = fakeSb([{ error: null }, { data: row({ id: "new", status: "running", busy_until: new Date(NOW + SEARCH_LOCK_MS).toISOString() }), error: null }]);
    const r = await claimRound1(sb, NEW, null, NOW);
    expect(r).toMatchObject({ ok: true, search: { id: "new" } });
    const insert = calls[1].ops.find(([m]) => m === "insert")![1][0] as Record<string, unknown>;
    expect(insert).toMatchObject({ input_hash: NEW.inputHash, status: "running", rounds: 1, cards: [], drops: {}, purpose_id: "p1", max_flight_hours: 3, busy_until: new Date(NOW + SEARCH_LOCK_MS).toISOString() });
    expect(Object.keys(insert)).not.toContain("owner_id");
    expect(Object.keys(insert)).not.toContain("id");
  });

  it("a reused row is updated in place, never while running, and the hash is not rewritten", async () => {
    const { sb, calls } = fakeSb([{ error: null }, { data: row({ status: "running" }), error: null }]);
    const r = await claimRound1(sb, NEW, "s1", NOW);
    expect(r.ok).toBe(true);
    const ops = calls[1].ops;
    expect(ops.find(([m]) => m === "update")![1][0]).not.toHaveProperty("input_hash");
    expect(ops).toContainEqual(["eq", ["id", "s1"]]);
    expect(ops).toContainEqual(["neq", ["status", "running"]]);
  });

  it("another running search of the user (partial unique index) -> busy", async () => {
    const { sb } = fakeSb([{ error: null }, { data: null, error: { code: "23505" } }, { data: null, error: null }]);
    expect(await claimRound1(sb, NEW, null, NOW)).toEqual({ ok: false, reason: "busy" });
    const again = fakeSb([{ error: null }, { data: null, error: { code: "23505" } }]);
    expect(await claimRound1(again.sb, NEW, "s1", NOW)).toEqual({ ok: false, reason: "busy" });
  });

  it("an identical search that appeared meanwhile (hash index) -> exists", async () => {
    const { sb } = fakeSb([{ error: null }, { data: null, error: { code: "23505" } }, { data: row(), error: null }]);
    expect(await claimRound1(sb, NEW, null, NOW)).toEqual({ ok: false, reason: "exists" });
  });

  it("a reused row that is running again -> exists (the caller reloads it)", async () => {
    const { sb } = fakeSb([{ error: null }, { data: null, error: null }]);
    expect(await claimRound1(sb, NEW, "s1", NOW)).toEqual({ ok: false, reason: "exists" });
  });

  it("any other database error throws", async () => {
    const { sb } = fakeSb([{ error: null }, { data: null, error: { code: "XX000" } }]);
    await expect(claimRound1(sb, NEW, null, NOW)).rejects.toThrow();
  });
});

describe("drive rows (find-destinations-drive section 8)", () => {
  const DRIVE_NEW: NewSearch = { ...NEW, origins: [], maxFlightHours: null, radiusKm: 360, travelMode: "drive", maxDriveHours: 4, home: { name: "Frankfurt am Main, Hesse, Germany", lat: 50.11, lon: 8.68 } };
  const driveRow = (o: Partial<SearchRow> = {}) =>
    row({ origins: [], max_flight_hours: null, radius_km: 360, travel_mode: "drive", max_drive_hours: "4.0", home_name: "Frankfurt", home_lat: 50.11, home_lon: 8.68, ...o });

  it("the new columns are inserted with the row, and written again when a row is reused (update grant)", async () => {
    const a = fakeSb([{ error: null }, { data: driveRow(), error: null }]);
    await claimRound1(a.sb, DRIVE_NEW, null, NOW);
    const insert = a.calls[1].ops.find(([m]) => m === "insert")![1][0] as Record<string, unknown>;
    expect(insert).toMatchObject({ travel_mode: "drive", max_drive_hours: 4, home_name: "Frankfurt am Main, Hesse, Germany", home_lat: 50.11, home_lon: 8.68, origins: [], max_flight_hours: null, radius_km: 360 });
    const b = fakeSb([{ error: null }, { data: driveRow(), error: null }]);
    await claimRound1(b.sb, DRIVE_NEW, "s1", NOW);
    expect(b.calls[1].ops.find(([m]) => m === "update")![1][0]).toMatchObject({ travel_mode: "drive", max_drive_hours: 4, home_lat: 50.11 });
  });

  it("a flight claim writes null drive columns (the mode_shape check)", async () => {
    const { sb, calls } = fakeSb([{ error: null }, { data: row(), error: null }]);
    await claimRound1(sb, NEW, null, NOW);
    expect(calls[1].ops.find(([m]) => m === "insert")![1][0]).toMatchObject({ travel_mode: "flight", max_drive_hours: null, home_name: null, home_lat: null, home_lon: null });
  });

  it("reads back: numeric hours as a number, the name in the view, the coordinates only on the server object", () => {
    const s = rowToSearch(driveRow());
    expect(s).toMatchObject({ travelMode: "drive", maxDriveHours: 4, homeName: "Frankfurt", homeLat: 50.11, homeLon: 8.68, maxFlightHours: null });
  });

  it("a row from before the migration (no drive columns) reads as a flight search", () => {
    const legacy = row() as Partial<SearchRow>;
    delete legacy.travel_mode;
    delete legacy.max_drive_hours;
    delete legacy.home_name;
    delete legacy.home_lat;
    delete legacy.home_lon;
    expect(rowToSearch(legacy as SearchRow)).toMatchObject({ travelMode: "flight", maxDriveHours: null, homeName: null, homeLat: null, homeLon: null });
  });

  it("drive_unavailable reads back as itself, not as failed", () => {
    expect(rowToSearch(driveRow({ status: "failed", error_code: "drive_unavailable" })).error).toBe("drive_unavailable");
  });

  it("saved flight cards without a drive key still load", () => {
    const flightCard = { id: "g1", round: 1, name: "X", reason: null, kind: "city", geoId: 1, placeName: "X", countryCode: "ES", admin1: null, place: { source: "geonames", fetchedAt: "t", stale: false }, flight: null, nearAirport: false, climate: null, pois: [] };
    expect(rowToSearch(row({ cards: [flightCard] })).cards).toHaveLength(1);
  });
});

describe("claimRound2", () => {
  it("only a done list with an unused round", async () => {
    const { sb, calls } = fakeSb([{ error: null }, { data: row({ status: "running" }), error: null }]);
    expect((await claimRound2(sb, "s1", NOW)).ok).toBe(true);
    expect(calls[1].ops).toContainEqual(["eq", ["status", "done"]]);
    expect(calls[1].ops).toContainEqual(["eq", ["rounds", 1]]);
  });
  it("lost the race -> exists; another running search -> busy", async () => {
    expect(await claimRound2(fakeSb([{ error: null }, { data: null, error: null }]).sb, "s1", NOW)).toEqual({ ok: false, reason: "exists" });
    expect(await claimRound2(fakeSb([{ error: null }, { data: null, error: { code: "23505" } }]).sb, "s1", NOW)).toEqual({ ok: false, reason: "busy" });
  });
});

describe("finishRound / failRound", () => {
  const previous = { ...rowToSearch(row({ cards: [], cost_micro_usd: 400 })), cards: [{ id: "g1" }], drops: { "1": { too_far: 2 } } } as unknown as StoredSearch;
  const card = { id: "g2" } as never;

  it("round 2 appends cards, keeps the drops of round 1 and adds the cost", async () => {
    const { sb, calls } = fakeSb([{ data: row({ rounds: 2 }), error: null }]);
    await finishRound(sb, "s1", { round: 2, cards: [card], drops: { climate: 1 }, costMicroUsd: 300, input: previous.input!, previous });
    const patch = calls[0].ops.find(([m]) => m === "update")![1][0] as Record<string, unknown>;
    expect(patch).toMatchObject({ status: "done", busy_until: null, rounds: 2, cost_micro_usd: 700, drops: { "1": { too_far: 2 }, "2": { climate: 1 } } });
    expect(patch.cards).toEqual([{ id: "g1" }, { id: "g2" }]);
  });

  it("round 1 replaces everything", async () => {
    const { sb, calls } = fakeSb([{ data: row(), error: null }]);
    await finishRound(sb, "s1", { round: 1, cards: [card], drops: { not_found: 1 }, costMicroUsd: 120, input: previous.input!, previous: null });
    const patch = calls[0].ops.find(([m]) => m === "update")![1][0] as Record<string, unknown>;
    expect(patch).toMatchObject({ rounds: 1, cards: [card], drops: { "1": { not_found: 1 } }, cost_micro_usd: 120 });
  });

  it("a failed round 1 leaves a failed row with the error code and the cost", async () => {
    const { sb, calls } = fakeSb([{ error: null }]);
    await failRound(sb, "s1", { round: 1, error: "ai_unavailable", costMicroUsd: 77, previous: null });
    expect(calls[0].ops.find(([m]) => m === "update")![1][0]).toEqual({ status: "failed", busy_until: null, error_code: "ai_unavailable", cost_micro_usd: 77 });
  });

  it("a failed round 2 puts the list back to done: cards and the unused round stay", async () => {
    const { sb, calls } = fakeSb([{ error: null }]);
    await failRound(sb, "s1", { round: 2, error: "ai_unavailable", costMicroUsd: 50, previous });
    expect(calls[0].ops.find(([m]) => m === "update")![1][0]).toEqual({ status: "done", busy_until: null, cost_micro_usd: 450 });
  });
});

describe("pruneSearches (newest 10 per user)", () => {
  it("deletes the rows beyond the newest 10, never the one just written", async () => {
    const { sb, calls } = fakeSb([{ data: [{ id: "old1" }, { id: "keep" }, { id: "old2" }], error: null }, { error: null }]);
    await pruneSearches(sb, "keep");
    expect(calls[0].ops).toContainEqual(["order", ["updated_at", { ascending: false }]]);
    expect(calls[0].ops).toContainEqual(["range", [10, 60]]);
    expect(calls[1].ops).toContainEqual(["in", ["id", ["old1", "old2"]]]);
  });
  it("nothing beyond 10 -> no delete; errors never throw", async () => {
    const empty = fakeSb([{ data: [], error: null }]);
    await pruneSearches(empty.sb, "keep");
    expect(empty.calls).toHaveLength(1);
    await expect(pruneSearches(fakeSb([{ data: null, error: { code: "x" } }]).sb, "keep")).resolves.toBeUndefined();
  });
});

describe("countRunsToday", () => {
  it("counts the user's destination_ideas rows from ai_usage", async () => {
    h.adminCount = { count: 3, error: null };
    expect(await countRunsToday("u1", new Date("2026-11-01T12:00:00Z"))).toBe(3);
  });
  it("throws on a read error so the caller fails closed", async () => {
    h.adminCount = { count: null, error: { code: "x" } };
    await expect(countRunsToday("u1")).rejects.toThrow();
  });
});
