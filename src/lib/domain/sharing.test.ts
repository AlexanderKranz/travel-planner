import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  accessOf,
  canEdit,
  MAX_SHARES_PER_RESOURCE,
  SHARE_ACCESS,
  SHARE_LOOKUPS_PER_DAY,
  SHARE_RESOURCES,
  ShareAccessInput,
  ShareIdInput,
  ShareInput,
  ShareTarget,
} from "./sharing";

const ID = "11111111-1111-4111-8111-111111111111";

describe("ShareTarget", () => {
  it("trims and lowercases the email", () => {
    expect(ShareTarget.parse({ email: "  Alice@Example.COM " })).toEqual({ email: "alice@example.com" });
  });
  it("rejects a malformed or too long email", () => {
    expect(ShareTarget.safeParse({ email: "not-an-email" }).success).toBe(false);
    expect(ShareTarget.safeParse({ email: `${"a".repeat(250)}@example.com` }).success).toBe(false);
    expect(ShareTarget.safeParse({ email: "" }).success).toBe(false);
  });
  it("accepts a user id (the admin form) and rejects a non-uuid", () => {
    expect(ShareTarget.parse({ userId: ID })).toEqual({ userId: ID });
    expect(ShareTarget.safeParse({ userId: "nope" }).success).toBe(false);
  });
  it("rejects an empty target and unknown shapes", () => {
    expect(ShareTarget.safeParse({}).success).toBe(false);
    expect(ShareTarget.safeParse({ name: "Bob" }).success).toBe(false);
  });
});

describe("ShareInput / ShareAccessInput / ShareIdInput", () => {
  it("accepts a trip or purpose share at both levels", () => {
    for (const resource of SHARE_RESOURCES) {
      for (const access of SHARE_ACCESS) {
        expect(ShareInput.safeParse({ resource, resourceId: ID, target: { email: "a@b.de" }, access }).success).toBe(true);
      }
    }
  });
  it("rejects unknown resources and levels, and a bad resource id", () => {
    expect(ShareInput.safeParse({ resource: "group", resourceId: ID, target: { email: "a@b.de" }, access: "read" }).success).toBe(false);
    expect(ShareInput.safeParse({ resource: "trip", resourceId: ID, target: { email: "a@b.de" }, access: "owner" }).success).toBe(false);
    expect(ShareInput.safeParse({ resource: "trip", resourceId: "x", target: { email: "a@b.de" }, access: "read" }).success).toBe(false);
  });
  it("access change and id inputs", () => {
    expect(ShareAccessInput.safeParse({ resource: "trip", shareId: ID, access: "write" }).success).toBe(true);
    expect(ShareAccessInput.safeParse({ resource: "trip", shareId: ID, access: "admin" }).success).toBe(false);
    expect(ShareIdInput.safeParse({ resource: "purpose", shareId: ID }).success).toBe(true);
    expect(ShareIdInput.safeParse({ resource: "purpose", shareId: "x" }).success).toBe(false);
  });
});

describe("limits", () => {
  it("the lookup limit is 20 a day", () => {
    expect(SHARE_LOOKUPS_PER_DAY).toBe(20);
  });
  it("MAX_SHARES_PER_RESOURCE equals the cap in share_resource (migration)", () => {
    const sql = readFileSync(new URL("../../../supabase/migrations/20261110120035_sharing.sql", import.meta.url), "utf8");
    const caps = [...sql.matchAll(/v_count >= (\d+)/g)].map((m) => Number(m[1]));
    expect(caps).toEqual([MAX_SHARES_PER_RESOURCE]);
  });
});

describe("accessOf / canEdit", () => {
  it("owner, share level, and read as the fail-closed default", () => {
    expect(accessOf("o", "o")).toBe("owner");
    expect(accessOf("o", "v", "write")).toBe("write");
    expect(accessOf("o", "v", "read")).toBe("read");
    expect(accessOf("o", "v")).toBe("read");
    expect(accessOf("o", "v", null)).toBe("read");
  });
  it("only the owner and a write grantee may edit", () => {
    expect(canEdit("owner")).toBe(true);
    expect(canEdit("write")).toBe(true);
    expect(canEdit("read")).toBe(false);
  });
});
