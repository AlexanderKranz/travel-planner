import { describe, expect, it } from "vitest";
import type { SharedItem } from "@/lib/domain/items";
import golf from "./__fixtures__/items-golf.json";
import { computeCosts, itemAmounts, partySize } from "./costs";

const base: SharedItem = {
  id: "x", category: "stay", title: "t", status: "booked", priceCents: 10000, priceBasis: "total",
  persons: null, currency: "EUR", day: null, ref: null, url: null, notes: null,
};
const it_ = (o: Partial<SharedItem>): SharedItem => ({ ...base, ...o });

describe("itemAmounts", () => {
  it("total basis divides by persons or party size", () => {
    expect(itemAmounts(base, 2)).toEqual({ totalCents: 10000, perPersonCents: 5000 });
    expect(itemAmounts({ ...base, persons: 4 }, 2).perPersonCents).toBe(2500);
    expect(itemAmounts(base, null)).toEqual({ totalCents: 10000, perPersonCents: null });
  });
  it("per-person basis multiplies", () => {
    const p = { ...base, priceBasis: "per_person" as const };
    expect(itemAmounts(p, 3)).toEqual({ totalCents: 30000, perPersonCents: 10000 });
    expect(itemAmounts(p, null)).toEqual({ totalCents: null, perPersonCents: 10000 });
  });
  it("rounds and handles unknown price", () => {
    expect(itemAmounts({ ...base, priceCents: 10001 }, 2).perPersonCents).toBe(5001);
    expect(itemAmounts({ ...base, priceCents: null }, 2)).toEqual({ totalCents: null, perPersonCents: null });
  });
});

describe("computeCosts golf fixture", () => {
  const s = computeCosts(golf as unknown as SharedItem[], 2);
  const eur = s.currencies[0]!;
  it("booked per person 1209,64", () => {
    expect(eur.currency).toBe("EUR");
    expect(eur.booked.perPersonCents).toBe(120964);
  });
  it("expected per person 1679,64 - 1769,64", () => {
    expect(eur.expected.perPerson).toEqual({ minCents: 167964, maxCents: 176964 });
  });
  it("rejected is counted but not summed", () => {
    expect(eur.counts.rejected).toBe(1);
    expect(eur.counts.option).toBe(4);
    expect(eur.incomplete).toBe(0);
  });
});

describe("computeCosts rules", () => {
  it("options group by category and day; planned always counts", () => {
    const s = computeCosts(
      [
        it_({ id: "1", status: "option", priceCents: 100, day: 1, category: "activity" }),
        it_({ id: "2", status: "option", priceCents: 300, day: 1, category: "activity" }),
        it_({ id: "3", status: "option", priceCents: 50, day: 2, category: "activity" }),
        it_({ id: "4", status: "planned", priceCents: 1000, category: "food" }),
      ],
      1,
    );
    expect(s.currencies[0]!.expected.total).toEqual({ minCents: 1150, maxCents: 1350 });
    expect(s.currencies[0]!.booked.totalCents).toBe(0);
  });
  it("unpriced and incomplete", () => {
    const s = computeCosts(
      [it_({ id: "1", priceCents: null }), it_({ id: "2", priceBasis: "per_person" })],
      null,
    );
    const c = s.currencies[0]!;
    expect(c.unpriced).toBe(1);
    expect(c.incomplete).toBe(1);
    expect(c.booked.perPersonCents).toBe(10000);
    expect(c.booked.totalCents).toBe(0);
  });
  it("separates currencies, EUR first then alphabetical", () => {
    const s = computeCosts([it_({ id: "1", currency: "USD" }), it_({ id: "2", currency: "CHF" }), it_({ id: "3" })], 1);
    expect(s.currencies.map((c) => c.currency)).toEqual(["EUR", "CHF", "USD"]);
  });
  it("empty", () => {
    expect(computeCosts([], null)).toEqual({ partySize: null, currencies: [] });
  });
});

describe("partySize", () => {
  it("sums counts, null without group", () => {
    expect(partySize([2, 1, 1])).toBe(4);
    expect(partySize(null)).toBeNull();
    expect(partySize([])).toBeNull();
  });
});
