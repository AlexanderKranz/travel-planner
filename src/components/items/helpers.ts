import { ITEM_CATEGORIES, type ItemCategory, type SharedItem } from "@/lib/domain/items";
import { itemAmounts } from "@/lib/items/costs";

export type Prefill = { title?: string; category?: ItemCategory; day?: number | null; ref?: string | null };

export type DayGroup<T extends SharedItem> = { day: number | null; items: T[] };

const catOrder = (c: ItemCategory) => ITEM_CATEGORIES.indexOf(c);

/** Active items by day (ascending, "no day" last), then category order, then title. Rejected items are split off. */
export function groupItems<T extends SharedItem>(items: T[]): { groups: DayGroup<T>[]; rejected: T[] } {
  const rejected = items.filter((i) => i.status === "rejected");
  const byDay = new Map<number | null, T[]>();
  for (const i of items) {
    if (i.status === "rejected") continue;
    byDay.set(i.day, [...(byDay.get(i.day) ?? []), i]);
  }
  const cmp = (a: T, b: T) => catOrder(a.category) - catOrder(b.category) || a.title.localeCompare(b.title);
  const groups = [...byDay.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([day, list]) => ({ day, items: [...list].sort(cmp) }));
  return { groups, rejected: [...rejected].sort(cmp) };
}

/** Host of a link without "www.", or null for anything that is not http(s). */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

/** ISO date of trip day n (1-based) for dated trips. */
export function dayDate(startDate: string | null, n: number): string | null {
  if (!startDate) return null;
  const d = new Date(`${startDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n - 1);
  return d.toISOString().slice(0, 10);
}

export type PriceLine = {
  primary: { kind: "perPerson" | "total"; cents: number };
  secondary: { kind: "perPerson" | "total"; cents: number } | null;
  sharedBy: number | null; // only when the item itself names the head count of a total price
};

/** What to show for an item's price: the entered amount first, the derived one second. */
export function priceLine(item: Pick<SharedItem, "priceCents" | "priceBasis" | "persons">, partySize: number | null): PriceLine | null {
  if (item.priceCents === null) return null;
  const a = itemAmounts(item, partySize);
  const primary =
    item.priceBasis === "per_person"
      ? { kind: "perPerson" as const, cents: item.priceCents }
      : { kind: "total" as const, cents: item.priceCents };
  const other =
    item.priceBasis === "per_person"
      ? a.totalCents !== null && a.totalCents !== item.priceCents
        ? { kind: "total" as const, cents: a.totalCents }
        : null
      : a.perPersonCents !== null && a.perPersonCents !== item.priceCents
        ? { kind: "perPerson" as const, cents: a.perPersonCents }
        : null;
  return { primary, secondary: other, sharedBy: item.priceBasis === "total" ? item.persons : null };
}

/** Quick-add prefill for a flight leg: outbound on day 1, return on the last day. */
export function flightPrefill(
  leg: { dir: "out" | "back"; number: string; from: string; to: string },
  lengthDays: number,
): Prefill {
  return {
    title: `${leg.number} ${leg.from} → ${leg.to}`,
    category: "flight",
    day: leg.dir === "out" ? 1 : Math.max(1, Math.min(60, lengthDays)),
    ref: null,
  };
}

/** Quick-add prefill for a place referenced in a day. */
export function placePrefill(place: { name: string }, ref: string, day: number): Prefill {
  return { title: place.name.slice(0, 120), category: "activity", day, ref };
}

export const CURRENCIES = ["EUR", "CHF", "GBP", "USD", "DKK", "SEK", "NOK", "PLN", "CZK", "HUF", "TRY"] as const;

/** Euro-cent string for a form field in the given locale ("432,64" in de); empty for null. */
export function centsToInput(cents: number | null, locale: string): string {
  if (cents === null) return "";
  return new Intl.NumberFormat(locale, { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2, useGrouping: false }).format(cents / 100);
}

export function isRange(m: { minCents: number; maxCents: number }): boolean {
  return m.minCents !== m.maxCents;
}
