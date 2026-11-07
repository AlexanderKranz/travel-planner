"use server";

import { z } from "zod";
import { ageOn } from "@/lib/age";
import { berlinToday } from "@/lib/date";
import { ageReferenceDate } from "@/lib/facts/trip-timing";
import type { GroupOwner } from "@/lib/domain/group";
import { fail, zodIssues, type ActionError, type ActionResult } from "@/lib/domain/result";
import {
  SHARE_LOOKUPS_PER_DAY,
  ShareAccessInput,
  ShareIdInput,
  ShareInput,
  SHARE_RESOURCES,
  type Grant,
  type IncomingShare,
  type Person,
  type ShareAccess,
  type ShareCandidate,
  type ShareResource,
} from "@/lib/domain/sharing";
import { berlinMidnight } from "./ai-usage";
import { getAdminSession } from "./admin/gate";
import { logEvent } from "./events";
import { getGroup } from "./groups";
import { loadOwnerContext } from "./owner-context";
import { getProfile } from "./profile";
import { PURPOSE_COLUMNS, type PurposeRow } from "./purpose-insert";
import { rowToPurpose } from "./purpose-mapping";
import { rateLimit } from "./rate-limit";
import { getUserSession } from "./session";
import { loadContacts, personOf } from "./share-contacts";
import { createSupabaseAdminClient } from "./supabase/admin";
import { rowToSummary, TRIP_COLUMNS, type TripSummaryRow } from "./trip-mapping";
import { getTrip } from "./trips";

/**
 * Sharing trips and purposes (docs/specs/sharing.md section 3, ADR 0010). One module for both resources.
 *
 * Grants are written ONLY through `rpc("share_resource")` with the secret key (2.9): clients have no insert or update
 * privilege on the share tables, so the email-only rule, the admin-only user list, the lookup limits and the events
 * below cannot be bypassed through the Data API. The function re-checks everything and is the security boundary; this
 * module authorizes the session first and maps the function's errors. Reads, unshare and leave use the user session
 * (RLS). Events carry ids and flags only, never emails, names or titles (the `sharing.` prefix keeps them apart from
 * the link events `share.*`).
 */

const TABLE = { trip: "trip_shares", purpose: "purpose_shares", group: "group_shares" } as const;
const RESOURCE_TABLE = { trip: "trips", purpose: "trip_purposes", group: "travel_groups" } as const;
const RESOURCE_COLUMN = { trip: "trip_id", purpose: "purpose_id", group: "group_id" } as const;

/** Per-minute lookup limit in memory (instances do not share it); the durable daily limit counts `app_events`. */
const LOOKUPS_PER_MINUTE = 5;
const MAX_USER_PAGES = 10;

type Session = NonNullable<Awaited<ReturnType<typeof getUserSession>>>;
type Failure = ReturnType<typeof fail>;

/** Messages `share_resource` raises with errcode P0001 (2.9) and the ActionError each one becomes. */
const SHARE_ERRORS: Record<string, ActionError> = {
  invalid: "invalid",
  forbidden: "forbidden",
  not_found: "not_found",
  self_share: "self_share",
  no_account: "no_account",
  limit_reached: "limit_reached",
};

function mapShareError(error: { code?: string; message?: string }): ActionError {
  return (error.code === "P0001" && error.message ? SHARE_ERRORS[error.message] : undefined) ?? "failed";
}

/** Owner of a resource through RLS: `not_found` when invisible, `forbidden` when visible but not the viewer's. */
async function requireOwnedResource(session: Session, resource: ShareResource, id: string): Promise<Failure | null> {
  const { data, error } = await session.supabase
    .from(RESOURCE_TABLE[resource])
    .select("owner_id")
    .eq("id", id)
    .maybeSingle<{ owner_id: string }>();
  if (error) return fail("failed");
  if (!data) return fail("not_found");
  return data.owner_id === session.userId ? null : fail("forbidden");
}

type GrantRow = { id: string; grantee_id: string; access: ShareAccess; created_at: string };

/** People who have access to one of the viewer's own trips or purposes (owner only). */
export async function listGrants(resource: ShareResource, id: string): Promise<ActionResult<Grant[]>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!z.enum(SHARE_RESOURCES).safeParse(resource).success || !z.string().uuid().safeParse(id).success) return fail("invalid");
  const denied = await requireOwnedResource(session, resource, id);
  if (denied) return denied;

  const [rows, contacts] = await Promise.all([
    session.supabase
      .from(TABLE[resource])
      .select("id, grantee_id, access, created_at")
      .eq(RESOURCE_COLUMN[resource], id)
      .order("created_at", { ascending: true })
      .returns<GrantRow[]>(),
    loadContacts(session.supabase),
  ]);
  if (rows.error || !contacts) return fail("failed");
  return {
    ok: true,
    data: rows.data.map((r) => ({
      id: r.id,
      grantee: personOf(contacts, r.grantee_id),
      access: r.access,
      createdAt: r.created_at,
    })),
  };
}

/**
 * Berlin-day lookup count of this user (durable: in-memory limits are per instance). The secret key reads `app_events`
 * (admin-only table) to count the user's own `sharing.lookup` rows; nothing else is read.
 */
async function lookupsToday(userId: string): Promise<number | null> {
  const { count, error } = await createSupabaseAdminClient()
    .from("app_events")
    .select("id", { count: "exact", head: true })
    .eq("event", "sharing.lookup")
    .eq("user_id", userId)
    .gte("created_at", berlinMidnight(new Date()).toISOString());
  return error ? null : (count ?? 0);
}

type Resolved = { ok: true; granteeId: string; via: "email" | "list" } | { ok: false; result: Failure };

/** Finds the recipient (3.3). Owners type an email (with limits); only admins may name a user id. */
async function resolveTarget(session: Session, isAdmin: boolean, target: ShareInput["target"]): Promise<Resolved> {
  if ("userId" in target) {
    // Admin list: the user id comes from listShareCandidates(); share_resource checks self and eligibility again.
    return isAdmin ? { ok: true, granteeId: target.userId, via: "list" } : { ok: false, result: fail("forbidden") };
  }
  // Limits first, before the lookup answers anything.
  if (!rateLimit(`share-lookup:${session.userId}`, LOOKUPS_PER_MINUTE, 60_000).ok) return { ok: false, result: fail("rate_limited") };
  let used: number | null;
  try {
    used = await lookupsToday(session.userId);
  } catch {
    used = null;
  }
  if (used === null) return { ok: false, result: fail("failed") }; // fail closed: an unreadable count must not open the gate
  if (used >= SHARE_LOOKUPS_PER_DAY) return { ok: false, result: fail("rate_limited") };

  let found: string | null;
  try {
    // Secret key: the function is executable by service_role only; unknown, demo and disabled accounts answer null.
    const { data, error } = await createSupabaseAdminClient().rpc("share_user_by_email", { p_email: target.email });
    if (error) return { ok: false, result: fail("failed") };
    found = typeof data === "string" ? data : null;
  } catch {
    return { ok: false, result: fail("failed") };
  }
  // Every lookup is logged, hit or miss, before the answer (only the flag, never the email).
  await logEvent({ event: "sharing.lookup", userId: session.userId, props: { found: found !== null } });
  return found ? { ok: true, granteeId: found, via: "email" } : { ok: false, result: fail("no_account") };
}

type ShareRpcRow = { share_id: string; created: boolean };

/** The one write path for grants. `p_owner` is always the session user, never client input. */
async function callShareResource(
  session: Session,
  args: { resource: ShareResource; resourceId: string; granteeId: string; access: ShareAccess; shareId?: string },
): Promise<{ ok: true; row: ShareRpcRow } | { ok: false; result: Failure }> {
  try {
    const { data, error } = await createSupabaseAdminClient().rpc("share_resource", {
      p_owner: session.userId,
      p_resource: args.resource,
      p_resource_id: args.resourceId,
      p_grantee: args.granteeId,
      p_access: args.access,
      ...(args.shareId ? { p_share_id: args.shareId } : {}),
    });
    if (error) return { ok: false, result: fail(mapShareError(error)) };
    const row = (Array.isArray(data) ? data[0] : data) as ShareRpcRow | undefined;
    if (!row || typeof row.share_id !== "string") return { ok: false, result: fail("failed") };
    return { ok: true, row };
  } catch {
    return { ok: false, result: fail("failed") };
  }
}

/** Shares an own trip or purpose with one person. A repeat for the same person changes the level (created = false). */
export async function shareWith(input: ShareInput): Promise<ActionResult<{ shareId: string; created: boolean }>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const parsed = ShareInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const { resource, resourceId, target, access } = parsed.data;

  const profile = await getProfile();
  if (!profile.ok) return fail("failed");
  if (profile.data.isDemo) return fail("demo_forbidden");

  const denied = await requireOwnedResource(session, resource, resourceId);
  if (denied) return denied;

  const who = await resolveTarget(session, profile.data.role === "admin", target);
  if (!who.ok) return who.result;

  const res = await callShareResource(session, { resource, resourceId, granteeId: who.granteeId, access });
  if (!res.ok) return res.result;
  await logEvent(
    res.row.created
      ? { event: "sharing.granted", userId: session.userId, props: { resource, resourceId, access, via: who.via } }
      : { event: "sharing.access_changed", userId: session.userId, props: { resource, resourceId, access } },
  );
  return { ok: true, data: { shareId: res.row.share_id, created: res.row.created } };
}

type OwnShareRow = { id: string; grantee_id: string; trip_id?: string; purpose_id?: string; group_id?: string };

/** Changes the level of an existing grant. Update-only: a grant that was left or revoked meanwhile is `not_found`. */
export async function setShareAccess(input: ShareAccessInput): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const parsed = ShareAccessInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const { resource, shareId, access } = parsed.data;

  // The share row through RLS, and only as its owner: a grantee sees their own row but cannot change it.
  const { data: row, error } = await session.supabase
    .from(TABLE[resource])
    .select(`id, grantee_id, ${RESOURCE_COLUMN[resource]}`)
    .eq("id", shareId)
    .eq("owner_id", session.userId)
    .maybeSingle<OwnShareRow>();
  if (error) return fail("failed");
  const resourceId = row ? row[RESOURCE_COLUMN[resource]] : undefined;
  if (!row || !resourceId) return fail("not_found");

  const res = await callShareResource(session, {
    resource,
    resourceId,
    granteeId: row.grantee_id,
    access,
    shareId: row.id, // update-only (2.9 step 5): a vanished row answers not_found and creates nothing
  });
  if (!res.ok) return res.result;
  await logEvent({ event: "sharing.access_changed", userId: session.userId, props: { resource, resourceId, access } });
  return { ok: true };
}

/** Removes a grant (owner side) through RLS. */
export async function unshare(input: ShareIdInput): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const parsed = ShareIdInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const { resource, shareId } = parsed.data;
  const { data, error } = await session.supabase
    .from(TABLE[resource])
    .delete()
    .eq("id", shareId)
    .eq("owner_id", session.userId)
    .select(`id, ${RESOURCE_COLUMN[resource]}`)
    .returns<{ id: string; trip_id?: string; purpose_id?: string; group_id?: string }[]>();
  if (error) return fail("failed");
  if (!data || data.length === 0) return fail("not_found");
  await logEvent({
    event: "sharing.revoked",
    userId: session.userId,
    props: { resource, resourceId: data[0][RESOURCE_COLUMN[resource]] ?? null },
  });
  return { ok: true };
}

/** The recipient gives a share up (grantee side) through RLS. The owner keeps the trip or purpose. */
export async function leaveShare(input: ShareIdInput): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const parsed = ShareIdInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const { resource, shareId } = parsed.data;
  const { data, error } = await session.supabase
    .from(TABLE[resource])
    .delete()
    .eq("id", shareId)
    .eq("grantee_id", session.userId)
    .select(`id, ${RESOURCE_COLUMN[resource]}`)
    .returns<{ id: string; trip_id?: string; purpose_id?: string; group_id?: string }[]>();
  if (error) return fail("failed");
  if (!data || data.length === 0) return fail("not_found");
  await logEvent({
    event: "sharing.left",
    userId: session.userId,
    props: { resource, resourceId: data[0][RESOURCE_COLUMN[resource]] ?? null },
  });
  return { ok: true };
}

type IncomingTripRow = {
  id: string;
  trip_id: string;
  owner_id: string;
  access: ShareAccess;
  created_at: string;
  trips: (Omit<TripSummaryRow, "trip_shares" | "share_count"> & { trip_shares?: never }) | null;
};
type IncomingPurposeRow = {
  id: string;
  purpose_id: string;
  owner_id: string;
  access: ShareAccess;
  created_at: string;
  trip_purposes: Omit<PurposeRow, "purpose_shares"> | null;
};
type IncomingGroupRow = {
  id: string;
  group_id: string;
  owner_id: string;
  access: ShareAccess;
  created_at: string;
  travel_groups: {
    id: string;
    name: string;
    notes: string | null;
    description: string | null;
    updated_at: string;
    group_entries: { count: number }[];
  } | null;
};

/**
 * Everything shared with the viewer, newest first (RLS hides the shares of a disabled owner). Trips come as summaries
 * with `sharedBy` and the viewer's `access`, purposes as full `TripPurpose` (usable, with the viewer's level).
 */
export async function listSharedWithMe(): Promise<ActionResult<IncomingShare[]>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const me = session.userId;
  const [trips, purposes, groups, contacts] = await Promise.all([
    session.supabase
      .from("trip_shares")
      .select(`id, trip_id, owner_id, access, created_at, trips(${TRIP_COLUMNS}, travel_groups(name), trip_purposes(name))`)
      .eq("grantee_id", me)
      .order("created_at", { ascending: false })
      .returns<IncomingTripRow[]>(),
    session.supabase
      .from("purpose_shares")
      .select(`id, purpose_id, owner_id, access, created_at, trip_purposes(${PURPOSE_COLUMNS})`)
      .eq("grantee_id", me)
      .order("created_at", { ascending: false })
      .returns<IncomingPurposeRow[]>(),
    session.supabase
      .from("group_shares")
      .select(`id, group_id, owner_id, access, created_at, travel_groups(id, name, notes, description, updated_at, group_entries(count))`)
      .eq("grantee_id", me)
      .order("created_at", { ascending: false })
      .returns<IncomingGroupRow[]>(),
    loadContacts(session.supabase),
  ]);
  if (trips.error || purposes.error || groups.error || !contacts) return fail("failed");

  const out: IncomingShare[] = [];
  for (const r of trips.data) {
    if (!r.trips) continue;
    const owner = personOf(contacts, r.owner_id);
    // The viewer's share row feeds the access mapping, exactly as for a trip read directly.
    const row = { ...r.trips, trip_shares: [{ grantee_id: me, access: r.access }] };
    out.push({
      id: r.id,
      resource: "trip",
      resourceId: r.trip_id,
      owner,
      access: r.access,
      createdAt: r.created_at,
      trip: rowToSummary(row as TripSummaryRow, me, owner),
      purpose: null,
      group: null,
    });
  }
  for (const r of groups.data) {
    if (!r.travel_groups) continue;
    const owner = personOf(contacts, r.owner_id);
    out.push({
      id: r.id,
      resource: "group",
      resourceId: r.group_id,
      owner,
      access: r.access,
      createdAt: r.created_at,
      trip: null,
      purpose: null,
      group: {
        id: r.travel_groups.id,
        name: r.travel_groups.name,
        notes: r.travel_groups.notes ?? undefined,
        description: r.travel_groups.description ?? undefined,
        entryCount: r.travel_groups.group_entries[0]?.count ?? 0,
        updatedAt: r.travel_groups.updated_at,
        access: r.access,
        sharedBy: owner,
        shareCount: 0,
      },
    });
  }
  for (const r of purposes.data) {
    if (!r.trip_purposes) continue;
    const row: PurposeRow = { ...r.trip_purposes, purpose_shares: [{ grantee_id: me, access: r.access }] };
    out.push({
      id: r.id,
      resource: "purpose",
      resourceId: r.purpose_id,
      owner: personOf(contacts, r.owner_id),
      access: r.access,
      createdAt: r.created_at,
      trip: null,
      group: null,
      purpose: rowToPurpose(row, me),
    });
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { ok: true, data: out };
}

/** Admin only: people an admin can share with (no email field for admins). Self, demo and disabled accounts are left out. */
export async function listShareCandidates(): Promise<ActionResult<ShareCandidate[]>> {
  const session = await getAdminSession();
  if (!session) return fail("forbidden");
  // Secret key: Auth admin API and profiles. Email and display name only; called after the admin check above.
  const admin = createSupabaseAdminClient();
  try {
    const users: { id: string; email?: string | null }[] = [];
    for (let page = 1; page <= MAX_USER_PAGES; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) return fail("failed");
      users.push(...data.users);
      if (data.users.length < 200) break;
    }
    const { data: profiles, error } = await admin
      .from("profiles")
      .select("id, display_name, is_demo, disabled_at")
      .limit(MAX_USER_PAGES * 200)
      .returns<{ id: string; display_name: string | null; is_demo: boolean; disabled_at: string | null }[]>();
    if (error) return fail("failed");
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const out: ShareCandidate[] = [];
    for (const u of users) {
      const p = byId.get(u.id);
      if (!u.email || !p || u.id === session.userId || p.is_demo || p.disabled_at) continue;
      out.push({ id: u.id, email: u.email, name: p.display_name });
    }
    out.sort((a, b) => a.email.localeCompare(b.email));
    return { ok: true, data: out };
  } catch {
    return fail("failed");
  }
}

export type TripOwnerContext = {
  owner: Person;
  /** Profile birthdate of the trip owner, only when the trip's group is theirs and has an `is_self` entry (decision A). */
  ownerBirthdate: string | null;
  /** The owner's age on the travel date, always when they have a birthdate ("about my age" stand-in without `ownerBirthdate`). */
  ownerAge: number | null;
  /** Owner of the trip's group when it is someone else's (name, birthdate only with an `is_self` entry); else null. */
  groupOwner: GroupOwner | null;
};

/**
 * Who owns a trip the viewer can see, and the owner's birthdate for the group block's `is_self` entry (decision A,
 * docs/specs/group-sharing.md 1.2 and 3.4). The owner's birthdate is read on the server (owner-context.ts) and returned
 * only when the trip's group has an `is_self` entry; nothing else of the profile leaves the server.
 */
export async function getTripOwnerContext(tripId: string): Promise<ActionResult<TripOwnerContext>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const trip = await getTrip(tripId); // RLS: only a trip the viewer may see
  if (!trip.ok) return fail(trip.error);
  const t = trip.data;
  const contacts = t.access === "owner" ? new Map<string, Person>() : await loadContacts(session.supabase);
  if (!contacts) return fail("failed");
  const owner = await loadOwnerContext(t.ownerId);
  if (!owner) return fail("failed");
  const today = berlinToday();
  let ownerAge: number | null = null;
  if (owner.birthdate) {
    try {
      ownerAge = ageOn(owner.birthdate, ageReferenceDate(t, today) ?? today);
    } catch {
      ownerAge = null; // travel date before the birthdate
    }
  }
  // The trip's saved group (RLS again). Decision A: the owner's birthdate goes to the client only when the group has an
  // `is_self` entry (that entry shows it); otherwise the age is all a viewer gets.
  const group = t.groupId ? await getGroup(t.groupId) : null;
  const g = group?.ok ? group.data : null;
  const ownGroupWithSelf = !!g && g.ownerId === t.ownerId && g.entries.some((e) => e.kind === "member" && e.isSelf);
  const known = contacts.get(t.ownerId);
  return {
    ok: true,
    data: {
      owner: known ?? { id: t.ownerId, name: owner.displayName, email: "" },
      ownerBirthdate: ownGroupWithSelf ? owner.birthdate : null,
      ownerAge,
      // A group of someone else (a recipient's trip with a shared group): its owner, with the same birthdate rule. Null
      // when the viewer is that owner (they know themselves) or the trip has no saved group.
      groupOwner: g && g.ownerId !== t.ownerId ? g.owner : null,
    },
  };
}
