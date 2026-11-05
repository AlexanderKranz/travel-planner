import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/plan/hash", () => ({ purposeTagsHash: () => "h1" }));

import type { PurposeRow } from "./purpose-insert";
import { rowToPurpose } from "./purpose-mapping";

const base: PurposeRow = {
  id: "p1", owner_id: "o1", name: "Golf", text: "t", guided: {}, constraints: [], parsed_tags: null, parsed_hash: null,
  created_at: "c", updated_at: "u",
};

describe("rowToPurpose: access and usable (sharing spec 3.1)", () => {
  it("the owner: access owner, usable", () => {
    expect(rowToPurpose(base, "o1")).toMatchObject({ ownerId: "o1", access: "owner", usable: true });
  });
  it("a purpose share gives its level and is usable at either level", () => {
    expect(rowToPurpose({ ...base, purpose_shares: [{ grantee_id: "v", access: "write" }] }, "v")).toMatchObject({ access: "write", usable: true });
    expect(rowToPurpose({ ...base, purpose_shares: [{ grantee_id: "v", access: "read" }] }, "v")).toMatchObject({ access: "read", usable: true });
  });
  it("a purpose reached only through a shared trip is read and NOT usable", () => {
    expect(rowToPurpose(base, "v")).toMatchObject({ ownerId: "o1", access: "read", usable: false });
    expect(rowToPurpose({ ...base, purpose_shares: [] }, "v")).toMatchObject({ access: "read", usable: false });
    expect(rowToPurpose({ ...base, purpose_shares: null }, "v").usable).toBe(false);
  });
  it("another grantee's share row does not count for the viewer", () => {
    expect(rowToPurpose({ ...base, purpose_shares: [{ grantee_id: "x", access: "write" }] }, "v")).toMatchObject({ access: "read", usable: false });
  });
  it("tags still follow the content hash", () => {
    const tags = { v: 1, interests: ["golf"], custom: [], hard: [], soft: [], summary: "s" };
    expect(rowToPurpose({ ...base, parsed_tags: tags, parsed_hash: "h1" }, "o1").tags).toEqual(tags);
    expect(rowToPurpose({ ...base, parsed_tags: tags, parsed_hash: "other" }, "o1").tags).toBeNull();
  });
});
