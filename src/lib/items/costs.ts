import { ITEM_STATUSES, type CostSummary, type CurrencyCosts, type ItemStatus, type SharedItem } from "@/lib/domain/items";

type PriceFields = Pick<SharedItem, "priceCents" | "priceBasis" | "persons">;
type Amounts = { totalCents: number | null; perPersonCents: number | null };

/** Total and per-person amount of one item. n = item.persons ?? party size; unknown n leaves one side null. */
export function itemAmounts(item: PriceFields, partySize: number | null): Amounts {
  if (item.priceCents === null) return { totalCents: null, perPersonCents: null };
  const n = item.persons ?? partySize;
  if (item.priceBasis === "total") {
    return { totalCents: item.priceCents, perPersonCents: n ? Math.round(item.priceCents / n) : null };
  }
  return { totalCents: n ? item.priceCents * n : null, perPersonCents: item.priceCents };
}

function emptyCounts(): Record<ItemStatus, number> {
  return Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0])) as Record<ItemStatus, number>;
}

type Acc = {
  c: CurrencyCosts;
  options: Map<string, { total: number[]; perPerson: number[] }>;
};

/** Costs per currency (no FX). Rules: docs/specs/phase-5-share-export.md 2.1. */
export function computeCosts(items: SharedItem[], partySize: number | null): CostSummary {
  const byCurrency = new Map<string, Acc>();
  for (const item of items) {
    let acc = byCurrency.get(item.currency);
    if (!acc) {
      acc = {
        c: {
          currency: item.currency,
          booked: { totalCents: 0, perPersonCents: 0 },
          expected: {
            total: { minCents: 0, maxCents: 0 },
            perPerson: { minCents: 0, maxCents: 0 },
          },
          counts: emptyCounts(),
          unpriced: 0,
          incomplete: 0,
        },
        options: new Map(),
      };
      byCurrency.set(item.currency, acc);
    }
    const { c } = acc;
    c.counts[item.status] += 1;
    if (item.status === "rejected") continue;
    if (item.priceCents === null) {
      c.unpriced += 1;
      continue;
    }
    const a = itemAmounts(item, partySize);
    if (a.totalCents === null || a.perPersonCents === null) c.incomplete += 1;

    if (item.status === "option") {
      const key = `${item.category}|${item.day ?? "none"}`;
      const g = acc.options.get(key) ?? { total: [], perPerson: [] };
      if (a.totalCents !== null) g.total.push(a.totalCents);
      if (a.perPersonCents !== null) g.perPerson.push(a.perPersonCents);
      acc.options.set(key, g);
      continue;
    }
    if (item.status === "booked") {
      c.booked.totalCents += a.totalCents ?? 0;
      c.booked.perPersonCents += a.perPersonCents ?? 0;
    }
    // booked and planned are both part of the expected range
    c.expected.total.minCents += a.totalCents ?? 0;
    c.expected.total.maxCents += a.totalCents ?? 0;
    c.expected.perPerson.minCents += a.perPersonCents ?? 0;
    c.expected.perPerson.maxCents += a.perPersonCents ?? 0;
  }

  const currencies = [...byCurrency.values()].map(({ c, options }) => {
    for (const g of options.values()) {
      if (g.total.length) {
        c.expected.total.minCents += Math.min(...g.total);
        c.expected.total.maxCents += Math.max(...g.total);
      }
      if (g.perPerson.length) {
        c.expected.perPerson.minCents += Math.min(...g.perPerson);
        c.expected.perPerson.maxCents += Math.max(...g.perPerson);
      }
    }
    return c;
  });
  currencies.sort((x, y) =>
    x.currency === y.currency ? 0 : x.currency === "EUR" ? -1 : y.currency === "EUR" ? 1 : x.currency < y.currency ? -1 : 1,
  );
  return { partySize, currencies };
}

/** Sum of group_entries.count (members count 1); null without a group. */
export function partySize(entryCounts: number[] | null): number | null {
  if (entryCounts === null) return null;
  const sum = entryCounts.reduce((s, n) => s + n, 0);
  return sum > 0 ? sum : null;
}
