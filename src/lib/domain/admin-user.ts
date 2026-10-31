import { z } from "zod";

/** Input of disable / enable / delete: only the target's id. Everything else is decided on the server. */
export const AdminUserInput = z.object({ userId: z.string().uuid() });
export type AdminUserInput = z.input<typeof AdminUserInput>;

export type AdminUserStatus = "active" | "disabled";

/** One row of the admin user list: account facts only, never trips, groups, notes or plan content. */
export type AdminUserEntry = {
  id: string;
  email: string;
  status: AdminUserStatus;
  lastSignInAt: string | null;
  /** Shown as a label; these accounts get no action buttons. The server enforces the same rules. */
  isSelf: boolean;
  isAdmin: boolean;
  isDemo: boolean;
  manageable: boolean;
};

/** Pure: the single rule for who may be disabled, enabled or deleted. Unknown role/flags are not manageable. */
export function isManageable(t: { isSelf: boolean; role: string | null; isDemo: boolean | null }): boolean {
  return !t.isSelf && t.role === "user" && t.isDemo === false;
}
