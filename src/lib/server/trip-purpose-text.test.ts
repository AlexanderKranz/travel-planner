import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  tag: vi.fn(),
  find: vi.fn(),
  logEvent: vi.fn(),
  update: vi.fn(),
  rows: { data: [{ id: "t1" }] as unknown[], error: null as unknown },
  stored: null as unknown,
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
      q.or = (...a: unknown[]) => (h.update({ or: a }), q);
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
const sb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.stored }) }) }) }) } as unknown as SupabaseClient;
const ctx = { onUsage: vi.fn() };

beforeEach(() => {
  h.tag.mockReset().mockResolvedValue({ ok: true, data: TAGS });
  h.find.mockReset().mockResolvedValue(null);
  h.logEvent.mockReset();
  h.update.mockReset();
  h.rows = { data: [{ id: "t1" }], error: null };
  h.stored = null;
});

describe("saveTripPurposeTags (compare-and-set)", () => {
  it("writes tags with the hash of the text, scoped to id, owner and the unchanged text, only while the tags are not yet stored", async () => {
    expect(await saveTripPurposeTags({ id: "t1", ownerId: "owner-1" }, TAGS, TEXT)).toBe(true);
    const hash = oneOffTagsHash(TEXT);
    expect(h.update.mock.calls.find((c) => c[0].payload)![0].payload).toMatchObject({ purpose_tags: TAGS, purpose_tags_hash: hash });
    expect(h.update.mock.calls.map((c) => c[0].eq).filter(Boolean)).toEqual([["id", "t1"], ["owner_id", "owner-1"], ["purpose_text", TEXT]]);
    expect(h.update.mock.calls.find((c) => c[0].or)![0].or).toEqual([`purpose_tags_hash.is.null,purpose_tags_hash.neq.${hash}`]);
  });
  it("false when no row matched (someone else was first, or the text changed) or the write fails", async () => {
    h.rows = { data: [], error: null };
    expect(await saveTripPurposeTags({ id: "t1", ownerId: "o" }, TAGS, TEXT)).toBe(false);
    h.rows = { data: [], error: { code: "x" } };
    expect(await saveTripPurposeTags({ id: "t1", ownerId: "o" }, TAGS, TEXT)).toBe(false);
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
    expect(res.purpose).toMatchObject({ tags: TAGS, updatedAt: purpose.updatedAt });
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
    expect(res).toEqual({ purpose });
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "purpose.tag_failed", props: expect.objectContaining({ source: "trip_text" }) }));
  });
  it("a failed call logs purpose.tag_failed without the text and leaves the purpose untagged", async () => {
    h.tag.mockResolvedValue({ ok: false, error: "ai_unavailable" });
    const res = await tagTripPurpose({ userId: "owner-1", sb }, trip, purpose, ctx);
    expect(res).toEqual({ purpose });
    const ev = h.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ event: "purpose.tag_failed", level: "warn", userId: "owner-1", props: { source: "trip_text", tripId: "t1", reason: "ai_unavailable" } });
    expect(JSON.stringify(ev)).not.toContain("Golf");
  });
  it("tags are used even when the save fails (nothing stored to prefer)", async () => {
    h.rows = { data: [], error: { code: "x" } };
    const res = await tagTripPurpose({ userId: "owner-1", sb }, trip, purpose, ctx);
    expect(res.purpose.tags).toEqual(TAGS);
  });
  it("lost the compare-and-set: the tags another run stored for this text win", async () => {
    const other = { ...TAGS, summary: "Andere" };
    h.rows = { data: [], error: null };
    h.stored = { purpose_text: TEXT, purpose_tags: other, purpose_tags_hash: oneOffTagsHash(TEXT) };
    const res = await tagTripPurpose({ userId: "owner-1", sb }, trip, purpose, ctx);
    expect(res.purpose.tags).toEqual(other);
  });
  it("stored tags for a different text are not used", async () => {
    h.rows = { data: [], error: null };
    h.stored = { purpose_text: "anders", purpose_tags: { ...TAGS, summary: "x" }, purpose_tags_hash: oneOffTagsHash("anders") };
    expect((await tagTripPurpose({ userId: "owner-1", sb }, trip, purpose, ctx)).purpose.tags).toEqual(TAGS);
  });
});
