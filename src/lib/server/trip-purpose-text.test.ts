import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  tag: vi.fn(),
  find: vi.fn(),
  logEvent: vi.fn(),
  update: vi.fn(),
  rows: { data: [{ updated_at: "2026-11-02T00:00:00Z" }] as unknown[], error: null as unknown },
}));
vi.mock("./ai/purpose-tags", () => ({ tagPurpose: h.tag }));
vi.mock("./discover/store", () => ({ findTagsByHash: h.find }));
vi.mock("./events", () => ({ logEvent: h.logEvent }));
vi.mock("./supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.update = (payload: unknown) => (h.update({ table, payload }), q);
      q.eq = (...a: unknown[]) => (h.update({ eq: a }), q);
      q.select = () => Promise.resolve(h.rows);
      return q;
    },
  }),
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import { oneOffTagsHash } from "@/lib/discover/one-off";
import { tripPurpose } from "@/lib/purpose-source";
import { saveTripPurposeTags, tagTripPurpose, wantsTripTags } from "./trip-purpose-text";

const TAGS = { v: 2 as const, interests: ["golf" as const], custom: [], hard: [], soft: [], summary: "Golf" };
const TEXT = "Golf mit einem Freund";
const trip = { id: "t1", ownerId: "owner-1", access: "owner" as const, purposeId: null, purposeText: TEXT, purposeTags: undefined, updatedAt: "2026-11-01T00:00:00Z" };
const purpose = tripPurpose(trip, null)!;
const sb = {} as SupabaseClient;
const ctx = { onUsage: vi.fn() };

beforeEach(() => {
  h.tag.mockReset().mockResolvedValue({ ok: true, data: TAGS });
  h.find.mockReset().mockResolvedValue(null);
  h.logEvent.mockReset();
  h.update.mockReset();
  h.rows = { data: [{ updated_at: "2026-11-02T00:00:00Z" }], error: null };
});

describe("saveTripPurposeTags", () => {
  it("writes the tags with hash and time, scoped to the trip id and the row's owner; returns the new updated_at", async () => {
    expect(await saveTripPurposeTags({ id: "t1", ownerId: "owner-1" }, TAGS, "h")).toEqual({ updatedAt: "2026-11-02T00:00:00Z" });
    const payload = h.update.mock.calls.find((c) => c[0].payload)![0].payload;
    expect(payload).toMatchObject({ purpose_tags: TAGS, purpose_tags_hash: "h" });
    expect(h.update.mock.calls.map((c) => c[0].eq).filter(Boolean)).toEqual([["id", "t1"], ["owner_id", "owner-1"]]);
  });
  it("null when no row was written or the write fails", async () => {
    h.rows = { data: [], error: null };
    expect(await saveTripPurposeTags({ id: "t1", ownerId: "o" }, TAGS, "h")).toBeNull();
    h.rows = { data: [], error: { code: "x" } };
    expect(await saveTripPurposeTags({ id: "t1", ownerId: "o" }, TAGS, "h")).toBeNull();
  });
});

describe("wantsTripTags", () => {
  it("only an untagged one-off purpose", () => {
    expect(wantsTripTags(purpose)).toBe(true);
    expect(wantsTripTags({ ...purpose, tags: TAGS })).toBe(false);
    expect(wantsTripTags({ ...purpose, id: "p1" })).toBe(false); // saved purposes use tagAndSave
    expect(wantsTripTags(null)).toBe(false);
  });
});

describe("tagTripPurpose", () => {
  it("one Haiku call charged through the actor's ctx, saved with the trip owner's id, returns the new updatedAt", async () => {
    const res = await tagTripPurpose({ userId: "owner-1", sb }, trip, purpose, ctx);
    expect(h.tag).toHaveBeenCalledOnce();
    expect(h.tag).toHaveBeenCalledWith(purpose, ctx);
    expect(h.update.mock.calls.find((c) => c[0].payload)![0].payload).toMatchObject({ purpose_tags_hash: oneOffTagsHash(TEXT) });
    expect(res.updatedAt).toBe("2026-11-02T00:00:00Z");
    expect(res.purpose).toMatchObject({ tags: TAGS, updatedAt: "2026-11-02T00:00:00Z" });
  });
  it("an earlier result for the same text is copied without a Haiku call (owner)", async () => {
    h.find.mockResolvedValue({ tags: TAGS, from: "search" });
    const res = await tagTripPurpose({ userId: "owner-1", sb }, trip, purpose, ctx);
    expect(h.find).toHaveBeenCalledWith(sb, oneOffTagsHash(TEXT), "owner-1");
    expect(h.tag).not.toHaveBeenCalled();
    expect(res.purpose.tags).toEqual(TAGS);
  });
  it("a write grantee skips the lookup (cannot read the owner's searches) and pays for the call", async () => {
    const res = await tagTripPurpose({ userId: "grantee-2", sb }, { ...trip, access: "write" }, purpose, ctx);
    expect(h.find).not.toHaveBeenCalled();
    expect(h.tag).toHaveBeenCalledWith(purpose, ctx);
    expect(h.update.mock.calls.find((c) => c[0].eq && c[0].eq[0] === "owner_id")![0].eq).toEqual(["owner_id", "owner-1"]);
    expect(res.purpose.tags).toEqual(TAGS);
  });
  it("a failed lookup fails closed: no Haiku call, logged", async () => {
    h.find.mockRejectedValue(new Error("read"));
    const res = await tagTripPurpose({ userId: "owner-1", sb }, trip, purpose, ctx);
    expect(h.tag).not.toHaveBeenCalled();
    expect(res).toEqual({ purpose, updatedAt: null });
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "purpose.tag_failed", props: expect.objectContaining({ source: "trip_text" }) }));
  });
  it("a failed call logs purpose.tag_failed without the text and leaves the purpose untagged", async () => {
    h.tag.mockResolvedValue({ ok: false, error: "ai_unavailable" });
    const res = await tagTripPurpose({ userId: "owner-1", sb }, trip, purpose, ctx);
    expect(res).toEqual({ purpose, updatedAt: null });
    const ev = h.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ event: "purpose.tag_failed", level: "warn", userId: "owner-1", props: { source: "trip_text", tripId: "t1", reason: "ai_unavailable" } });
    expect(JSON.stringify(ev)).not.toContain("Golf");
  });
  it("tags are used even when the save fails (updatedAt unchanged)", async () => {
    h.rows = { data: [], error: { code: "x" } };
    const res = await tagTripPurpose({ userId: "owner-1", sb }, trip, purpose, ctx);
    expect(res.purpose.tags).toEqual(TAGS);
    expect(res.updatedAt).toBeNull();
    expect(res.purpose.updatedAt).toBe(purpose.updatedAt);
  });
});
