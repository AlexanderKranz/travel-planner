import { z } from "zod";
import type { TripPurpose } from "./purpose";
import type { TripSummary } from "./trip";

/** Sharing trips and purposes between users (docs/specs/sharing.md section 3.1). */

export const SHARE_ACCESS = ["read", "write"] as const;
export type ShareAccess = (typeof SHARE_ACCESS)[number];
/** What the viewer is for a trip or purpose: the owner, or a grantee at one of the two levels. */
export type Access = "owner" | ShareAccess;
export const SHARE_RESOURCES = ["trip", "purpose"] as const;
export type ShareResource = (typeof SHARE_RESOURCES)[number];
/** Mirrored by `share_resource` step 6 in migration 20261110120035; a test compares them. */
export const MAX_SHARES_PER_RESOURCE = 10;
/** Email lookups per user and Berlin day (spec 3.3). */
export const SHARE_LOOKUPS_PER_DAY = 20;

export const ShareTarget = z.union([
  z.object({ email: z.string().trim().toLowerCase().email().max(254) }),
  z.object({ userId: z.string().uuid() }), // admins only (3.3)
]);
export type ShareTarget = z.infer<typeof ShareTarget>;

export const ShareInput = z.object({
  resource: z.enum(SHARE_RESOURCES),
  resourceId: z.string().uuid(),
  target: ShareTarget,
  access: z.enum(SHARE_ACCESS),
});
export type ShareInput = z.input<typeof ShareInput>;

export const ShareAccessInput = z.object({
  resource: z.enum(SHARE_RESOURCES),
  shareId: z.string().uuid(),
  access: z.enum(SHARE_ACCESS),
});
export type ShareAccessInput = z.input<typeof ShareAccessInput>;

export const ShareIdInput = z.object({ resource: z.enum(SHARE_RESOURCES), shareId: z.string().uuid() });
export type ShareIdInput = z.input<typeof ShareIdInput>;

/** name = display_name (may be null). */
export type Person = { id: string; name: string | null; email: string };
/** One grant on a resource of the viewer (owner side). */
export type Grant = { id: string; grantee: Person; access: ShareAccess; createdAt: string };
/**
 * One incoming share (grantee side). `trip` is set for resource "trip", `purpose` for resource "purpose": the summary
 * the "Shared with me" cards show (a null means the resource could not be read, e.g. a row removed meanwhile).
 */
export type IncomingShare = {
  id: string;
  resource: ShareResource;
  resourceId: string;
  owner: Person;
  access: ShareAccess;
  createdAt: string;
  trip: TripSummary | null;
  purpose: TripPurpose | null;
};
/** Admin list of people to share with (no email field for admins). */
export type ShareCandidate = { id: string; email: string; name: string | null };

/**
 * The viewer's access to a resource: the owner, else the level of the viewer's share row, else `read` (a purpose that is
 * readable only because it sits on a trip shared with the viewer, or a row without a visible share, fails closed).
 */
export function accessOf(ownerId: string, viewerId: string, shareAccess?: ShareAccess | null): Access {
  if (ownerId === viewerId) return "owner";
  return shareAccess === "write" ? "write" : "read";
}

/** Owner or write grantee: may edit (spec 1.1). */
export const canEdit = (access: Access): boolean => access === "owner" || access === "write";
