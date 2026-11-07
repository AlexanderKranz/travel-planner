import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  adminCalls: [] as { table: string; ops: [string, unknown[]][] }[],
  adminResult: { data: [{ id: "s1" }] as unknown, error: null as unknown },
}));
vi.mock("../supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from(table: string) {
      const call = { table, ops: [] as [string, unknown[]][] };
      h.adminCalls.push(call);
      const q: Record<string, unknown> = {};
      for (const m of ["update", "eq", "select"]) q[m] = (...a: unknown[]) => (call.ops.push([m, a]), q);
      q.then = (res: (v: unknown) => unknown) => res(h.adminResult);
      return q;
    },
  }),
}));

import { oneOffTagsHash } from "@/lib/discover/one-off";
import { adoptSource, claimRound1, findTagsByHash, getSearchTags, rowToSearch, saveSearchTags, SEARCH_COLUMNS, type NewSearch, type SearchRow, type StoredSearch } from "./store";

/** A user-session client double: every call is recorded, every awaited chain pops the next programmed result. */
function fakeSb(results: unknown[]) {
  const calls: { table: string; ops: [string, unknown[]][] }[] = [];
  const queue = [...results];
  const sb = {
    from(table: string) {
      const call = { table, ops: [] as [string, unknown[]][] };
      calls.push(call);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "insert", "update", "eq", "neq", "lt", "or", "order", "limit", "returns"]) q[m] = (...a: unknown[]) => (call.ops.push([m, a]), q);
      for (const m of ["maybeSingle", "single"]) q[m] = (...a: unknown[]) => (call.ops.push([m, a]), Promise.resolve(queue.shift()));
      q.then = (res: (v: unknown) => unknown) => res(queue.shift());
      return q;
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

const TAGS = { v: 1, interests: ["golf"], custom: [], hard: [], soft: [], summary: "Golf" };
const TEXT = "Golf mit einem Freund";
const baseRow = (o: Partial<SearchRow> = {}): SearchRow => ({
  id: "s1", purpose_id: "p1", group_id: null, purpose_name: "Golf", purpose_text: null, locale: "de", months: [3], origins: ["FRA"],
  max_flight_hours: null, radius_km: null, travel_mode: "flight", max_drive_hours: null, home_name: null, home_lat: null, home_lon: null,
  input_hash: "a".repeat(64), input: { v: 1 }, status: "done", busy_until: null, rounds: 1, cards: [], drops: {}, error_code: null,
  model: null, cost_micro_usd: 0, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z", ...o,
});
const stored = (o: Partial<SearchRow> = {}): StoredSearch => rowToSearch(baseRow(o));
const updateOf = (calls: { ops: [string, unknown[]][] }[]) => calls.flatMap((c) => c.ops).find(([m]) => m === "update")?.[1][0];

beforeEach(() => {
  h.adminCalls.length = 0;
  h.adminResult = { data: [{ id: "s1" }], error: null };
});

describe("SEARCH_COLUMNS / rowToSearch", () => {
  it("reads purpose_text but not the tag columns", () => {
    expect(SEARCH_COLUMNS).toContain("purpose_text");
    expect(SEARCH_COLUMNS).not.toContain("purpose_tags");
    expect(stored({ purpose_text: TEXT }).purposeText).toBe(TEXT);
    expect(stored().purposeText).toBeNull();
  });
});

describe("findTagsByHash (13.2: search rows first, then own and shared purposes)", () => {
  it("a search row with the hash wins and the purposes are not read", async () => {
    const { sb, calls } = fakeSb([{ data: [{ purpose_tags: TAGS }], error: null }]);
    expect(await findTagsByHash(sb, "h", "u1")).toEqual({ tags: TAGS, from: "search" });
    expect(calls.map((c) => c.table)).toEqual(["destination_searches"]);
    expect(calls[0].ops).toContainEqual(["eq", ["purpose_tags_hash", "h"]]);
    expect(calls[0].ops).toContainEqual(["order", ["updated_at", { ascending: false }]]);
  });
  it("then a purpose with the same parsed_hash", async () => {
    const { sb, calls } = fakeSb([{ data: [], error: null }, { data: [], error: null }, { data: [{ parsed_tags: TAGS }], error: null }]);
    expect(await findTagsByHash(sb, "h", "u1")).toEqual({ tags: TAGS, from: "purpose" });
    expect(calls.map((c) => c.table)).toEqual(["destination_searches", "purpose_shares", "trip_purposes"]);
    expect(calls[2].ops).toContainEqual(["eq", ["parsed_hash", "h"]]);
  });
  it("reads own purposes and purposes shared with the user, not purposes seen only through a shared trip", async () => {
    const { sb, calls } = fakeSb([
      { data: [], error: null },
      { data: [{ purpose_id: "ps1" }, { purpose_id: "ps2" }], error: null },
      { data: [{ parsed_tags: TAGS }], error: null },
    ]);
    expect(await findTagsByHash(sb, "h", "u1")).toEqual({ tags: TAGS, from: "purpose" });
    // The share rows are the user's own incoming ones; the purpose query names the owner and exactly those ids.
    expect(calls[1].ops).toContainEqual(["eq", ["grantee_id", "u1"]]);
    expect(calls[2].ops).toContainEqual(["or", ["owner_id.eq.u1,id.in.(ps1,ps2)"]]);
  });
  it("then an own trip with the same purpose_tags_hash (owner filter, shared trips are not used)", async () => {
    const { sb, calls } = fakeSb([{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [{ purpose_tags: TAGS }], error: null }]);
    expect(await findTagsByHash(sb, "h", "u1")).toEqual({ tags: TAGS, from: "trip" });
    expect(calls.map((c) => c.table)).toEqual(["destination_searches", "purpose_shares", "trip_purposes", "trips"]);
    expect(calls[3].ops).toContainEqual(["eq", ["owner_id", "u1"]]);
    expect(calls[3].ops).toContainEqual(["eq", ["purpose_tags_hash", "h"]]);
  });
  it("a purpose wins over a trip", async () => {
    const { sb, calls } = fakeSb([{ data: [], error: null }, { data: [], error: null }, { data: [{ parsed_tags: TAGS }], error: null }]);
    expect(await findTagsByHash(sb, "h", "u1")).toEqual({ tags: TAGS, from: "purpose" });
    expect(calls.map((c) => c.table)).not.toContain("trips");
  });
  it("without incoming shares only the own purposes are read", async () => {
    const { sb, calls } = fakeSb([{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }]);
    expect(await findTagsByHash(sb, "h", "u1")).toBeNull();
    expect(calls[2].ops).toContainEqual(["or", ["owner_id.eq.u1"]]);
  });
  it("invalid stored tags count as missing, a later valid row is used", async () => {
    const { sb } = fakeSb([{ data: [{ purpose_tags: { bad: 1 } }, { purpose_tags: TAGS }], error: null }]);
    expect(await findTagsByHash(sb, "h", "u1")).toEqual({ tags: TAGS, from: "search" });
    const none = fakeSb([{ data: [{ purpose_tags: { bad: 1 } }], error: null }, { data: [], error: null }, { data: [{ parsed_tags: null }], error: null }, { data: [{ purpose_tags: null }], error: null }]);
    expect(await findTagsByHash(none.sb, "h", "u1")).toBeNull();
  });
  it("a read error throws (the caller fails closed instead of spending a Haiku call)", async () => {
    await expect(findTagsByHash(fakeSb([{ data: null, error: { code: "x" } }]).sb, "h", "u1")).rejects.toThrow();
    await expect(findTagsByHash(fakeSb([{ data: [], error: null }, { data: null, error: { code: "x" } }]).sb, "h", "u1")).rejects.toThrow();
    await expect(findTagsByHash(fakeSb([{ data: [], error: null }, { data: [], error: null }, { data: null, error: { code: "x" } }]).sb, "h", "u1")).rejects.toThrow();
    await expect(findTagsByHash(fakeSb([{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: null, error: { code: "x" } }]).sb, "h", "u1")).rejects.toThrow();
  });
});

describe("saveSearchTags (secret key, owner-scoped, best effort)", () => {
  it("writes tags and hash for the one row of the owner", async () => {
    expect(await saveSearchTags("u1", "s1", TAGS as never, "h")).toBe(true);
    const call = h.adminCalls[0];
    expect(call.table).toBe("destination_searches");
    expect(call.ops).toContainEqual(["update", [{ purpose_tags: TAGS, purpose_tags_hash: "h" }]]);
    expect(call.ops).toContainEqual(["eq", ["id", "s1"]]);
    expect(call.ops).toContainEqual(["eq", ["owner_id", "u1"]]);
  });
  it("returns false on an error or when no row matched, never throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.adminResult = { data: null, error: { code: "x" } };
    expect(await saveSearchTags("u1", "s1", TAGS as never, "h")).toBe(false);
    h.adminResult = { data: [], error: null };
    expect(await saveSearchTags("u1", "s1", TAGS as never, "h")).toBe(false);
    spy.mockRestore();
  });
});

describe("getSearchTags", () => {
  it("returns tags with their hash, or null without a valid pair", async () => {
    expect(await getSearchTags(fakeSb([{ data: { purpose_tags: TAGS, purpose_tags_hash: "h" }, error: null }]).sb, "s1")).toEqual({ tags: TAGS, hash: "h" });
    expect(await getSearchTags(fakeSb([{ data: { purpose_tags: null, purpose_tags_hash: null }, error: null }]).sb, "s1")).toBeNull();
    expect(await getSearchTags(fakeSb([{ data: { purpose_tags: { bad: 1 }, purpose_tags_hash: "h" }, error: null }]).sb, "s1")).toBeNull();
    expect(await getSearchTags(fakeSb([{ data: null, error: null }]).sb, "s1")).toBeNull();
  });
});

describe("claimRound1 writes the source of the current run (13.3)", () => {
  const NEW: NewSearch = {
    purposeId: null, groupId: null, purposeName: TEXT, purposeText: TEXT, locale: "de", months: [3], origins: ["FRA"], maxFlightHours: 3,
    radiusKm: 2128, travelMode: "flight", maxDriveHours: null, home: null, inputHash: "b".repeat(64),
    input: { v: 1, lang: "de", purpose: { interests: [], custom: [], hard: [], soft: [] }, count: 8 }, model: "m",
  };
  it("a new row for a typed text: no purpose id, the text", async () => {
    const { sb, calls } = fakeSb([{ data: [], error: null }, { data: baseRow({ purpose_id: null, purpose_text: TEXT }), error: null }]);
    const r = await claimRound1(sb, NEW, null);
    expect(r.ok && r.search.purposeText).toBe(TEXT);
    expect(updateOf(calls)).toBeUndefined();
    const insert = calls.flatMap((c) => c.ops).find(([m]) => m === "insert")![1][0] as Record<string, unknown>;
    expect(insert).toMatchObject({ purpose_id: null, purpose_text: TEXT, purpose_name: TEXT });
    expect(insert).not.toHaveProperty("purpose_tags");
    expect(insert).not.toHaveProperty("purpose_tags_hash");
  });
  it("a row taken over in place for a saved purpose clears the text of the earlier request", async () => {
    const { sb, calls } = fakeSb([{ data: [], error: null }, { data: baseRow(), error: null }]);
    await claimRound1(sb, { ...NEW, purposeId: "p1", purposeName: "Golf", purposeText: null }, "s1");
    expect(updateOf(calls)).toMatchObject({ purpose_id: "p1", purpose_name: "Golf", purpose_text: null });
  });
});

describe("adoptSource (13.3: a served row takes the source of the request)", () => {
  it("saved request on a typed row: clears the text, sets purpose and name", async () => {
    const { sb, calls } = fakeSb([{ data: baseRow({ purpose_id: "p2", purpose_name: "Beach", purpose_text: null }), error: null }]);
    const r = await adoptSource(sb, "u1", stored({ purpose_id: null, purpose_text: TEXT, purpose_name: TEXT }), { kind: "saved", purposeId: "p2", name: "Beach" });
    expect(r.relabelled).toBe(true);
    expect(updateOf(calls)).toEqual({ purpose_id: "p2", purpose_name: "Beach", purpose_text: null });
    expect(calls[0].ops).toContainEqual(["eq", ["id", "s1"]]);
    expect(r.search).toMatchObject({ purposeId: "p2", purposeText: null, purposeName: "Beach" });
    expect(h.adminCalls).toHaveLength(0);
  });
  it("a shared purpose P: the row takes purpose_id and purpose_name of P (the trigger accepts it while the share exists)", async () => {
    const { sb, calls } = fakeSb([{ data: baseRow({ purpose_id: "shared-p", purpose_name: "Golf (shared)" }), error: null }]);
    const r = await adoptSource(sb, "u1", stored({ purpose_id: null, purpose_text: TEXT, purpose_name: TEXT }), { kind: "saved", purposeId: "shared-p", name: "Golf (shared)" });
    expect(r.relabelled).toBe(true);
    expect(updateOf(calls)).toEqual({ purpose_id: "shared-p", purpose_name: "Golf (shared)", purpose_text: null });
    expect(r.search).toMatchObject({ purposeId: "shared-p", purposeName: "Golf (shared)" });
  });
  it("saved request on a row of another saved purpose with the same input (identical tags) relabels too", async () => {
    const { sb, calls } = fakeSb([{ data: baseRow({ purpose_id: "p2", purpose_name: "Second" }), error: null }]);
    const r = await adoptSource(sb, "u1", stored({ purpose_id: "p1" }), { kind: "saved", purposeId: "p2", name: "Second" });
    expect(r.relabelled).toBe(true);
    expect(updateOf(calls)).toMatchObject({ purpose_id: "p2", purpose_text: null });
  });
  it("typed request on a saved row: sets text and label, clears the purpose, then stores the tags", async () => {
    const { sb, calls } = fakeSb([{ data: baseRow({ purpose_id: null, purpose_name: TEXT, purpose_text: TEXT }), error: null }]);
    const r = await adoptSource(sb, "u1", stored(), { kind: "text", text: TEXT, tags: TAGS as never });
    expect(r.relabelled).toBe(true);
    expect(updateOf(calls)).toEqual({ purpose_id: null, purpose_name: TEXT, purpose_text: TEXT });
    expect(r.search).toMatchObject({ purposeId: null, purposeText: TEXT });
    expect(h.adminCalls[0].ops).toContainEqual(["update", [{ purpose_tags: TAGS, purpose_tags_hash: oneOffTagsHash(TEXT) }]]);
  });
  it("typed request without tags relabels but writes no tags", async () => {
    const { sb } = fakeSb([{ data: baseRow({ purpose_id: null, purpose_text: TEXT }), error: null }]);
    await adoptSource(sb, "u1", stored(), { kind: "text", text: TEXT, tags: null });
    expect(h.adminCalls).toHaveLength(0);
  });
  it("the label of a long text is cut by code and fits the 80-character column", async () => {
    const long = "Golf mit einem Freund, flache Plätze, gutes Essen, höchstens 3 Stunden Flug ab Frankfurt";
    const { sb, calls } = fakeSb([{ data: baseRow({ purpose_id: null, purpose_text: long }), error: null }]);
    await adoptSource(sb, "u1", stored(), { kind: "text", text: long, tags: null });
    const patch = updateOf(calls) as { purpose_name: string };
    expect(patch.purpose_name.endsWith("…")).toBe(true);
    expect(patch.purpose_name.length).toBeLessThanOrEqual(60);
  });
  it("matching sources write nothing (saved on saved, typed on typed)", async () => {
    const a = fakeSb([]);
    expect((await adoptSource(a.sb, "u1", stored({ purpose_id: "p1" }), { kind: "saved", purposeId: "p1", name: "Golf" })).relabelled).toBe(false);
    const b = fakeSb([]);
    expect((await adoptSource(b.sb, "u1", stored({ purpose_id: null, purpose_text: TEXT }), { kind: "text", text: TEXT, tags: TAGS as never })).relabelled).toBe(false);
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
    expect(h.adminCalls).toHaveLength(0);
  });
  it("a typed request on the row linked to the purpose saved from that text writes nothing", async () => {
    const { sb, calls } = fakeSb([]);
    const r = await adoptSource(sb, "u1", stored({ purpose_id: "p-new", purpose_text: TEXT }), { kind: "text", text: TEXT, tags: TAGS as never });
    expect(r.relabelled).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("a saved request on the linked row (purpose_id = P) keeps the text and writes nothing", async () => {
    const { sb, calls } = fakeSb([]);
    const r = await adoptSource(sb, "u1", stored({ purpose_id: "p-new", purpose_text: TEXT }), { kind: "saved", purposeId: "p-new", name: "Golf" });
    expect(r.relabelled).toBe(false);
    expect(r.search.purposeText).toBe(TEXT);
    expect(calls).toHaveLength(0);
  });
  it("also relabels a running row (no status filter)", async () => {
    const { sb, calls } = fakeSb([{ data: baseRow({ status: "running", purpose_id: null, purpose_text: TEXT, busy_until: new Date(Date.now() + 60_000).toISOString() }), error: null }]);
    await adoptSource(sb, "u1", stored({ status: "running", busy_until: new Date(Date.now() + 60_000).toISOString() }), { kind: "text", text: TEXT, tags: null });
    expect(calls[0].ops.map(([m]) => m)).not.toContain("neq");
  });
  it("a write error throws; a vanished row falls back to the patched copy", async () => {
    await expect(adoptSource(fakeSb([{ data: null, error: { code: "x" } }]).sb, "u1", stored(), { kind: "text", text: TEXT, tags: null })).rejects.toThrow();
    const r = await adoptSource(fakeSb([{ data: null, error: null }]).sb, "u1", stored(), { kind: "text", text: TEXT, tags: null });
    expect(r.search).toMatchObject({ purposeId: null, purposeText: TEXT });
  });
});
