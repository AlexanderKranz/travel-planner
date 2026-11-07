import type { ActionError } from "@/lib/domain";
import type { IncomingShare, Person } from "@/lib/domain/sharing";

/** What the UI calls a person: display name, else email. */
export const personLabel = (p: Pick<Person, "name" | "email">): string => p.name?.trim() || p.email;

/** Error keys that have their own text in `sharing.errors`; everything else falls back to `failed`. */
const SHARE_ERRORS = [
  "no_account",
  "self_share",
  "limit_reached",
  "rate_limited",
  "share_daily_limit",
  "forbidden",
  "demo_forbidden",
  "invalid",
  "not_found",
  "already_linked",
  "already_claimed",
] as const;
export type ShareErrorKey = (typeof SHARE_ERRORS)[number] | "failed";

export function shareErrorKey(error: ActionError): ShareErrorKey {
  return (SHARE_ERRORS as readonly string[]).includes(error) ? (error as ShareErrorKey) : "failed";
}

/**
 * A birthdate that yields exactly `age` on `onDate` (same month and day, `age` years earlier; 29 Feb falls back to
 * 28 Feb). Only an age stand-in for "about my age" when the server sent the owner's age but no birthdate (the group has
 * no `is_self` entry, spec group-sharing 1.2): it is never shown. A real birthdate always wins and is displayed.
 */
export function birthdateForAge(age: number, onDate: string): string {
  const [y, m, d] = onDate.split("-").map(Number);
  const year = y - age;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = m === 2 && d === 29 && !leap ? 28 : d;
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export type SharedPurposeOption = { id: string; name: string; ownerName: string };

/** Purposes shared with me that can be picked for own trips and searches (`usable`), with the owner's name. */
export function sharedPurposeOptions(shares: IncomingShare[]): SharedPurposeOption[] {
  return shares.flatMap((s) =>
    s.resource === "purpose" && s.purpose?.usable
      ? [{ id: s.purpose.id, name: s.purpose.name, ownerName: personLabel(s.owner) }]
      : [],
  );
}

export type SharedGroupOption = { id: string; name: string; ownerName: string };

/** Groups shared with me (either level) that can be picked for own trips and searches, with the owner's name. */
export function sharedGroupOptions(shares: IncomingShare[]): SharedGroupOption[] {
  return shares.flatMap((s) =>
    s.resource === "group" && s.group ? [{ id: s.group.id, name: s.group.name, ownerName: personLabel(s.owner) }] : [],
  );
}
