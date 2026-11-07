import type { StoredEntry, TravelGroup } from "@/lib/domain/group";
import { canClaim } from "@/lib/domain/group";

/**
 * How one group entry looks to the VIEWER (docs/specs/group-sharing.md 1.5), and which link button it offers. Pure, so
 * the labels per viewer can be tested without rendering. The raw `linkedUserId` is never used for display.
 *
 * - `who`: "you" = the viewer's own entry (the `is_self` entry for the owner, the claimed entry for a recipient);
 *   "groupOwner" = the owner's `is_self` entry as a recipient sees it; "typed" = the name the owner typed.
 * - `mark`: what is shown next to a typed name: the linked person's name for the owner, "Linked" for everyone else.
 * - `action`: "claim" (That's me), "unclaim" (That's not me, my own link), "remove" (the owner removes any link).
 */
export type EntryLinkView = {
  who: "you" | "groupOwner" | "typed";
  mark: { kind: "person"; name: string } | { kind: "account" } | null;
  action: "claim" | "unclaim" | "remove" | null;
};

type ViewGroup = Pick<TravelGroup, "access" | "myEntryId">;

export function entryLinkView(group: ViewGroup, entry: StoredEntry): EntryLinkView {
  const link = entry.link;
  if (group.access === "owner") {
    if (entry.kind === "member" && entry.isSelf) return { who: "you", mark: null, action: null };
    if (link?.kind === "person") return { who: "typed", mark: link, action: "remove" };
    if (link?.kind === "account") return { who: "typed", mark: link, action: "remove" };
    return { who: "typed", mark: null, action: null };
  }
  if (entry.kind === "member" && entry.isSelf) return { who: "groupOwner", mark: null, action: null };
  if (group.myEntryId !== null && entry.id === group.myEntryId) return { who: "you", mark: null, action: "unclaim" };
  if (link?.kind === "account" || link?.kind === "person") return { who: "typed", mark: { kind: "account" }, action: null };
  return { who: "typed", mark: null, action: canClaim(group, entry) ? "claim" : null };
}

/** Write grantees may not delete the owner's `is_self` entry or an entry linked to someone else (guard trigger). */
export function entryDeleteLocked(group: ViewGroup, entry: StoredEntry): boolean {
  if (group.access === "owner") return false;
  if (entry.kind === "member" && entry.isSelf) return true;
  return entry.link !== undefined && entry.id !== group.myEntryId;
}
