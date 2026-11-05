import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let count = 0;
let insertRow: Record<string, unknown> | null = null;
/** What the trips read answers: null = invisible trip, else the owner and the viewer's share rows. */
let tripRead: { owner_id: string; trip_shares: { grantee_id: string; access: string }[] } | null = null;
/** What the item's trip lookup answers (trip_items.select("trip_id")). */
let itemTrip: { trip_id: string } | null = null;
const writes: string[] = [];
const row = {
  id: "i1", trip_id: "t1", category: "stay", title: "Airbnb", status: "option", price_cents: null, price_basis: "total",
  persons: null, currency: "EUR", day: null, ref: null, url: null, notes: null, created_at: "a", updated_at: "b",
};
function head() {
  const t: Record<string, unknown> = { then: (r: (v: unknown) => unknown) => Promise.resolve({ count, error: null }).then(r) };
  t.eq = () => t;
  return t;
}
function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["eq", "order", "returns"]) b[m] = () => b;
  b.select = (c: string, opts?: { head?: boolean }) => {
    if (opts?.head) return head();
    // The write gate's reads: the trip's access, and the trip of an item.
    if (table === "trips") b.maybeSingle = async () => ({ data: tripRead, error: null });
    else if (c === "trip_id") b.maybeSingle = async () => ({ data: itemTrip, error: null });
    else b.maybeSingle = async () => ({ data: row, error: null });
    return b;
  };
  b.insert = (r: Record<string, unknown>) => {
    insertRow = r;
    writes.push("insert");
    return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
  };
  b.update = () => {
    writes.push("update");
    const u: Record<string, unknown> = { then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: "i1" }], error: null }).then(r) };
    u.eq = () => u;
    u.select = () => u;
    u.maybeSingle = async () => ({ data: row, error: null });
    return u;
  };
  b.delete = () => {
    writes.push("delete");
    const d: Record<string, unknown> = { then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: "i1" }], error: null }).then(r) };
    d.eq = () => d;
    d.select = () => d;
    return d;
  };
  return b;
}
vi.mock("./session", () => ({ getUserSession: async () => ({ userId: "U", supabase: { from: builder } }) }));

import { createItem, deleteItem, setItemStatus, updateItem } from "./items";

const TRIP = "11111111-1111-4111-8111-111111111111";
const valid = {
  category: "stay", title: "Airbnb", priceCents: null, persons: null, day: null, ref: null, url: null, notes: null,
};

beforeEach(() => {
  count = 0;
  insertRow = null;
  tripRead = { owner_id: "U", trip_shares: [] }; // the viewer owns the trip
  itemTrip = { trip_id: "11111111-1111-4111-8111-111111111111" };
  writes.length = 0;
});

describe("item actions", () => {
  it("creates with trip_id and no owner_id", async () => {
    const r = await createItem(TRIP, valid);
    expect(r.ok).toBe(true);
    expect(insertRow).toMatchObject({ trip_id: TRIP, status: "option", currency: "EUR" });
    expect(insertRow).not.toHaveProperty("owner_id");
  });
  it("enforces Zod limits", async () => {
    for (const bad of [
      { ...valid, title: "" },
      { ...valid, title: "x".repeat(121) },
      { ...valid, priceCents: -1 },
      { ...valid, priceCents: 100_000_001 },
      { ...valid, currency: "eur" },
      { ...valid, url: "javascript:alert(1)" },
      { ...valid, notes: "x".repeat(1001) },
      { ...valid, day: 61 },
    ]) {
      expect(await createItem(TRIP, bad)).toMatchObject({ ok: false, error: "invalid" });
    }
    expect(insertRow).toBeNull();
  });
  it("caps at 100 items", async () => {
    count = 100;
    expect(await createItem(TRIP, valid)).toEqual({ ok: false, error: "limit_reached" });
  });
  describe("access on a shared trip (sharing spec 3.5)", () => {
    const ITEM = "22222222-2222-4222-8222-222222222222";
    const asGrantee = (access: string) => {
      tripRead = { owner_id: "owner", trip_shares: [{ grantee_id: "U", access }] };
    };

    it("a read grantee gets forbidden on every write, and nothing is written", async () => {
      asGrantee("read");
      expect(await createItem(TRIP, valid)).toEqual({ ok: false, error: "forbidden" });
      expect(await updateItem(ITEM, valid)).toEqual({ ok: false, error: "forbidden" });
      expect(await setItemStatus(ITEM, "booked")).toEqual({ ok: false, error: "forbidden" });
      expect(await deleteItem(ITEM)).toEqual({ ok: false, error: "forbidden" });
      expect(writes).toEqual([]);
    });
    it("a write grantee may add, edit, set the status and delete", async () => {
      asGrantee("write");
      expect((await createItem(TRIP, valid)).ok).toBe(true);
      expect((await updateItem(ITEM, valid)).ok).toBe(true);
      expect((await setItemStatus(ITEM, "booked")).ok).toBe(true);
      expect((await deleteItem(ITEM)).ok).toBe(true);
      expect(writes).toEqual(["insert", "update", "update", "delete"]);
    });
    it("a trip that is not visible is not_found, not forbidden", async () => {
      tripRead = null;
      expect(await createItem(TRIP, valid)).toEqual({ ok: false, error: "not_found" });
      itemTrip = null;
      expect(await deleteItem(ITEM)).toEqual({ ok: false, error: "not_found" });
      expect(writes).toEqual([]);
    });
    it("a stranger's share row for someone else does not count: the viewer's own row decides", async () => {
      tripRead = { owner_id: "owner", trip_shares: [{ grantee_id: "somebody-else", access: "write" }] };
      expect(await createItem(TRIP, valid)).toEqual({ ok: false, error: "forbidden" });
    });
  });
  it("rejects bad ids and statuses", async () => {
    expect(await createItem("nope", valid)).toMatchObject({ error: "invalid" });
    expect(await setItemStatus("nope", "booked")).toMatchObject({ error: "invalid" });
    expect(await setItemStatus(TRIP, "weird" as never)).toMatchObject({ error: "invalid" });
  });
});
