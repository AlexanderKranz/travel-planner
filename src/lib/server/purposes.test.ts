import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const hash = vi.hoisted(() => ({ fn: vi.fn(() => "h1") }));
vi.mock("@/lib/plan/hash", () => ({ purposeTagsHash: hash.fn }));
vi.mock("./events", () => ({ logEvent: vi.fn() }));
let row: Record<string, unknown> = {};
vi.mock("./session", () => ({
  getUserSession: async () => ({
    userId: "u",
    supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }) },
  }),
}));

import { getPurpose } from "./purposes";

const tags = { v: 1, interests: ["golf"], custom: [], hard: ["a"], soft: [], summary: "s" };
const base = { id: "00000000-0000-4000-8000-000000000001", name: "n", text: "t", guided: {}, constraints: [], created_at: "c", updated_at: "u" };
const id = base.id;

describe("parsed_* mapping", () => {
  it("maps tags when the hash matches", async () => {
    row = { ...base, parsed_tags: tags, parsed_hash: "h1" };
    const r = await getPurpose(id);
    expect(r.ok && r.data.tags).toEqual(tags);
  });
  it("null when the hash differs (purpose edited), tags invalid, or none stored", async () => {
    row = { ...base, parsed_tags: tags, parsed_hash: "other" };
    expect((await getPurpose(id) as { data: { tags: unknown } }).data.tags).toBeNull();
    row = { ...base, parsed_tags: { bad: 1 }, parsed_hash: "h1" };
    expect((await getPurpose(id) as { data: { tags: unknown } }).data.tags).toBeNull();
    row = { ...base, parsed_tags: null, parsed_hash: null };
    expect((await getPurpose(id) as { data: { tags: unknown } }).data.tags).toBeNull();
  });
  it("null when hashing throws", async () => {
    hash.fn.mockImplementationOnce(() => { throw new Error("x"); });
    row = { ...base, parsed_tags: tags, parsed_hash: "h1" };
    expect((await getPurpose(id) as { data: { tags: unknown } }).data.tags).toBeNull();
  });
});
