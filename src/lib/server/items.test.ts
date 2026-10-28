import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let count = 0;
let insertRow: Record<string, unknown> | null = null;
const row = {
  id: "i1", trip_id: "t1", category: "stay", title: "Airbnb", status: "option", price_cents: null, price_basis: "total",
  persons: null, currency: "EUR", day: null, ref: null, url: null, notes: null, created_at: "a", updated_at: "b",
};
function head() {
  const t: Record<string, unknown> = { then: (r: (v: unknown) => unknown) => Promise.resolve({ count, error: null }).then(r) };
  t.eq = () => t;
  return t;
}
function builder() {
  const b: Record<string, unknown> = {};
  for (const m of ["eq", "order", "returns"]) b[m] = () => b;
  b.select = (_c: string, opts?: { head?: boolean }) =>
    opts?.head ? head() : b;
  b.insert = (r: Record<string, unknown>) => {
    insertRow = r;
    return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
  };
  return b;
}
vi.mock("./session", () => ({ getUserSession: async () => ({ userId: "U", supabase: { from: builder } }) }));

import { createItem, setItemStatus } from "./items";

const TRIP = "11111111-1111-4111-8111-111111111111";
const valid = {
  category: "stay", title: "Airbnb", priceCents: null, persons: null, day: null, ref: null, url: null, notes: null,
};

beforeEach(() => {
  count = 0;
  insertRow = null;
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
  it("rejects bad ids and statuses", async () => {
    expect(await createItem("nope", valid)).toMatchObject({ error: "invalid" });
    expect(await setItemStatus("nope", "booked")).toMatchObject({ error: "invalid" });
    expect(await setItemStatus(TRIP, "weird" as never)).toMatchObject({ error: "invalid" });
  });
});
