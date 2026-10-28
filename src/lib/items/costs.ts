import type { CostSummary, SharedItem } from "@/lib/domain/items";
import { notImplemented } from "@/lib/plan/not-implemented";

export function itemAmounts(
  _item: Pick<SharedItem, "priceCents" | "priceBasis" | "persons">,
  _partySize: number | null,
): { totalCents: number | null; perPersonCents: number | null } {
  return notImplemented("itemAmounts");
}

export function computeCosts(_items: SharedItem[], _partySize: number | null): CostSummary {
  return notImplemented("computeCosts");
}

/** Sum of group_entries.count (members count 1); null without a group. */
export function partySize(_entryCounts: number[] | null): number | null {
  return notImplemented("partySize");
}
