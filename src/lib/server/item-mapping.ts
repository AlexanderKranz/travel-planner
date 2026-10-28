import type { SharedItem, TripItem, TripItemInputParsed } from "@/lib/domain/items";

/** snake_case row of public.trip_items (columns the app reads). */
export type ItemRow = {
  id: string;
  trip_id: string;
  category: TripItem["category"];
  title: string;
  status: TripItem["status"];
  price_cents: number | null;
  price_basis: TripItem["priceBasis"];
  persons: number | null;
  currency: string;
  day: number | null;
  ref: string | null;
  url: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export const ITEM_COLUMNS =
  "id, trip_id, category, title, status, price_cents, price_basis, persons, currency, day, ref, url, notes, created_at, updated_at";

/** Public (share) read: no trip_id/timestamps; `notes` is appended only when the link allows it. */
export const SHARED_ITEM_COLUMNS =
  "id, category, title, status, price_cents, price_basis, persons, currency, day, ref, url";

export type SharedItemRow = Omit<ItemRow, "trip_id" | "created_at" | "updated_at" | "notes"> & { notes?: string | null };

export function rowToItem(r: ItemRow): TripItem {
  return { ...rowToSharedItem(r, true), tripId: r.trip_id, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function rowToSharedItem(r: SharedItemRow, includeNotes: boolean): SharedItem {
  return {
    id: r.id,
    category: r.category,
    title: r.title,
    status: r.status,
    priceCents: r.price_cents === null ? null : Number(r.price_cents),
    priceBasis: r.price_basis,
    persons: r.persons,
    currency: r.currency,
    day: r.day,
    ref: r.ref as SharedItem["ref"],
    url: r.url,
    notes: includeNotes ? (r.notes?.trim() ? r.notes : null) : null,
  };
}

/** Writable columns (never id, owner_id, trip_id, timestamps). "" notes become null. */
export function itemToWrite(i: TripItemInputParsed) {
  return {
    category: i.category,
    title: i.title,
    status: i.status,
    price_cents: i.priceCents,
    price_basis: i.priceBasis,
    persons: i.persons,
    currency: i.currency,
    day: i.day,
    ref: i.ref,
    url: i.url,
    notes: i.notes && i.notes.trim() ? i.notes.trim() : null,
  };
}
