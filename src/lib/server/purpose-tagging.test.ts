import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  tag: vi.fn(),
  save: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock("./ai/purpose-tags", () => ({ needsTags: () => true, tagPurpose: h.tag }));
vi.mock("./plan-store", () => ({ savePurposeTags: h.save }));
vi.mock("./events", () => ({ logEvent: h.logEvent }));
vi.mock("@/lib/plan/hash", () => ({ purposeTagsHash: () => "th" }));

import type { TripPurpose } from "@/lib/domain/purpose";
import { tagAndSave } from "./purpose-tagging";

const TAGS = { v: 1, interests: ["golf"], custom: [], hard: [], soft: [], summary: "s" };
const purpose = { id: "p1", ownerId: "owner-1", access: "read", usable: true, name: "Golf", guided: {}, constraints: [], tags: null, createdAt: "c", updatedAt: "u" } as unknown as TripPurpose;

beforeEach(() => {
  h.tag.mockReset().mockResolvedValue({ ok: true, data: TAGS });
  h.save.mockReset().mockResolvedValue({ updatedAt: "u2" });
  h.logEvent.mockReset();
});

describe("tagAndSave (shared purposes, sharing spec 3.5)", () => {
  it("saves the tags with the PURPOSE OWNER's id; the call goes through the actor's usage context", async () => {
    const ctx = { onUsage: vi.fn() };
    const res = await tagAndSave("actor-2", purpose, ctx);
    expect(h.tag).toHaveBeenCalledWith(purpose, ctx);
    expect(h.save).toHaveBeenCalledWith("owner-1", "p1", TAGS, "th");
    expect(res).toMatchObject({ tags: TAGS, updatedAt: "u2" });
  });
  it("a failed call is logged for the actor and leaves the purpose unchanged", async () => {
    h.tag.mockResolvedValue({ ok: false, error: "ai_unavailable" });
    expect(await tagAndSave("actor-2", purpose, { onUsage: vi.fn() })).toBe(purpose);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "purpose.tag_failed", userId: "actor-2" }));
  });
});
