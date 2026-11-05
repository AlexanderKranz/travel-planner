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
  "forbidden",
  "demo_forbidden",
  "invalid",
  "not_found",
] as const;
export type ShareErrorKey = (typeof SHARE_ERRORS)[number] | "failed";

export function shareErrorKey(error: ActionError): ShareErrorKey {
  return (SHARE_ERRORS as readonly string[]).includes(error) ? (error as ShareErrorKey) : "failed";
}

/**
 * A birthdate that yields exactly `age` on `onDate` (same month and day, `age` years earlier; 29 Feb falls back to
 * 28 Feb). A recipient of a shared trip gets the owner's age on the travel date from the server, never the real
 * birthdate; the group resolution needs a birthdate for the `is_self` entry, so this stand-in feeds it.
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
