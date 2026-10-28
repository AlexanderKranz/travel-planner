import { describe, expect, it } from "vitest";
import { TripItemInput } from "@/lib/domain/items";
import { itemToWrite, rowToItem, rowToSharedItem, SHARED_ITEM_COLUMNS, type ItemRow } from "./item-mapping";

const row: ItemRow = {
  id: "i1", trip_id: "t1", category: "stay", title: "Airbnb", status: "booked", price_cents: 45900,
  price_basis: "total", persons: 2, currency: "EUR", day: null, ref: "node/12", url: "https://x.test/a",
  notes: "code ABC123", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
};

describe("item mapping", () => {
  it("round trips through the Zod input", () => {
    const item = rowToItem(row);
    expect(item.tripId).toBe("t1");
    const parsed = TripItemInput.parse(item);
    const w = itemToWrite(parsed);
    expect(w).toMatchObject({ title: "Airbnb", price_cents: 45900, persons: 2, ref: "node/12", notes: "code ABC123" });
    expect(Object.keys(w)).not.toContain("trip_id");
    expect(Object.keys(w)).not.toContain("owner_id");
  });
  it("blank notes become null", () => {
    const p = TripItemInput.parse({ ...rowToItem(row), notes: "   " });
    expect(itemToWrite(p).notes).toBeNull();
  });
  it("shared mapping drops notes unless allowed", () => {
    expect(rowToSharedItem(row, false).notes).toBeNull();
    expect(rowToSharedItem(row, true).notes).toBe("code ABC123");
    expect(SHARED_ITEM_COLUMNS).not.toContain("notes");
    expect(SHARED_ITEM_COLUMNS).not.toContain("owner_id");
  });
});
