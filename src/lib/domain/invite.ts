import { z } from "zod";
import { Locale } from "./profile";

export const InviteInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  locale: Locale,
});
export type InviteInput = z.input<typeof InviteInput>;

export const InviteRevokeInput = z.object({ id: z.number().int().positive() });

/**
 * pending: allowlisted, but the person has not signed in yet (invite mail sent, or not yet used)
 * accepted: has signed in at least once
 */
export type InviteStatus = "pending" | "accepted";

export type InviteEntry = {
  id: number;
  email: string;
  note: string | null;
  createdAt: string;
  status: InviteStatus;
  /** Revoke removes the allowlist row and the never-used account; accepted accounts stay (use account deletion). */
  revocable: boolean;
};

/** `lastSignInAt`: from auth.users, null when the user has never signed in or does not exist yet. */
export function inviteStatus(lastSignInAt: string | null | undefined): InviteStatus {
  return lastSignInAt ? "accepted" : "pending";
}
