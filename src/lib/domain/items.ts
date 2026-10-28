import { z } from "zod";
import { HHMM, OsmKey } from "./plan";

export const ITEM_CATEGORIES = ["flight", "stay", "car", "transport", "activity", "food", "other"] as const;
export const ITEM_STATUSES = ["option", "planned", "booked", "rejected"] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);
export const MAX_ITEMS_PER_TRIP = 100;

export const TripItemInput = z
  .object({
    category: z.enum(ITEM_CATEGORIES),
    title: z.string().trim().min(1).max(120),
    status: z.enum(ITEM_STATUSES).default("option"),
    priceCents: z.number().int().min(0).max(100_000_000).nullable(),
    priceBasis: z.enum(["total", "per_person"]).default("total"),
    persons: z.number().int().min(1).max(50).nullable(), // how many share a `total` price (null = party size)
    currency: CurrencyCode.default("EUR"),
    day: z.number().int().min(1).max(60).nullable(),
    ref: OsmKey.nullable(),
    url: z
      .string()
      .max(500)
      .url()
      .refine((u) => /^https?:\/\//.test(u))
      .nullable(),
    notes: z.string().trim().max(1000).nullable(), // "" -> null in the mapper
    // Local times at the destination (HH:MM). endTime < startTime = ends the next day (overnight flight) [D2].
    startTime: HHMM.nullable().default(null),
    endTime: HHMM.nullable().default(null),
  })
  .refine((i) => i.endTime === null || i.startTime !== null, { path: ["endTime"], message: "start required" });
export type TripItemInputParsed = z.infer<typeof TripItemInput>;
export type TripItem = TripItemInputParsed & {
  id: string;
  tripId: string;
  createdAt: string;
  updatedAt: string;
};
export type SharedItem = Omit<TripItem, "tripId" | "createdAt" | "updatedAt">;

export type Money = { minCents: number; maxCents: number }; // min === max -> single value
export type CurrencyCosts = {
  currency: string;
  booked: { totalCents: number; perPersonCents: number };
  expected: { total: Money; perPerson: Money }; // booked + planned + option groups
  counts: Record<ItemStatus, number>;
  unpriced: number; // non-rejected items without a price
  incomplete: number; // priced items whose total or per-person amount is unknown (no party size)
};
export type CostSummary = { partySize: number | null; currencies: CurrencyCosts[] }; // EUR first, then alphabetical
