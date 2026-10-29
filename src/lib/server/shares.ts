"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
import {
  MAX_LINKS_PER_TRIP,
  ShareLinkInput,
  type CreatedShareLink,
  type ShareLink,
} from "@/lib/domain/share";
import { getAppUrl } from "./app-url";
import { logEvent } from "./events";
import { getProfile } from "./profile";
import { getPlanRow, getVersion } from "./plan-store";
import { rateLimit } from "./rate-limit";
import { getUserSession } from "./session";
import { newShareToken } from "./share-token";

const Id = z.string().uuid();
const FK_VIOLATION = "23503";
const DAY_MS = 86_400_000;

// token_hash is deliberately absent: clients have no select grant on it.
const LINK_COLUMNS =
  "id, trip_id, label, include_items, include_item_notes, expires_at, view_count, last_viewed_at, created_at";

type LinkRow = {
  id: string;
  trip_id: string;
  label: string | null;
  include_items: boolean;
  include_item_notes: boolean;
  expires_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  created_at: string;
};

function rowToLink(r: LinkRow): ShareLink {
  return {
    id: r.id,
    tripId: r.trip_id,
    label: r.label,
    includeItems: r.include_items,
    includeItemNotes: r.include_item_notes,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    viewCount: r.view_count,
    lastViewedAt: r.last_viewed_at,
  };
}

/** Expired links stay listed (the UI marks them) until revoked. */
export async function listShareLinks(tripId: string): Promise<ActionResult<ShareLink[]>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(tripId).success) return fail("invalid");
  const { data, error } = await session.supabase
    .from("share_links")
    .select(LINK_COLUMNS)
    .eq("trip_id", tripId)
    .order("created_at", { ascending: false })
    .returns<LinkRow[]>();
  if (error) return fail("failed");
  return { ok: true, data: data.map(rowToLink) };
}

export async function createShareLink(tripId: string, input: unknown): Promise<ActionResult<CreatedShareLink>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(tripId).success) return fail("invalid");
  const parsed = ShareLinkInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const rl = rateLimit(`share-create:${session.userId}`, 10, 60_000);
  if (!rl.ok) return fail("rate_limited");

  const profile = await getProfile();
  if (!profile.ok) return fail("failed");
  if (profile.data.isDemo) return fail("demo_forbidden");

  const sb = session.supabase;
  const { data: trip, error: tripError } = await sb.from("trips").select("id").eq("id", tripId).maybeSingle();
  if (tripError) return fail("failed");
  if (!trip) return fail("not_found");

  let planLocale: string;
  try {
    const plan = await getPlanRow(sb, tripId);
    if (!plan || plan.latestVersion < 1) return fail("no_plan");
    const version = await getVersion(sb, plan.id, plan.latestVersion);
    if (!version) return fail("no_plan");
    planLocale = version.plan.locale;
  } catch {
    return fail("failed");
  }

  const base = getAppUrl();
  if (!base) return fail("failed");

  const now = Date.now();
  const { count, error: countError } = await sb
    .from("share_links")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", tripId)
    .or(`expires_at.is.null,expires_at.gt.${new Date(now).toISOString()}`);
  if (countError) return fail("failed");
  if ((count ?? 0) >= MAX_LINKS_PER_TRIP) return fail("limit_reached");

  const { token, hash } = newShareToken();
  const { includeItems } = parsed.data;
  const { data, error } = await sb
    .from("share_links")
    .insert({
      trip_id: tripId,
      token_hash: hash, // the token itself is never stored
      label: parsed.data.label && parsed.data.label.length > 0 ? parsed.data.label : null,
      include_items: includeItems,
      include_item_notes: includeItems && parsed.data.includeItemNotes,
      expires_at: parsed.data.expiresInDays === null ? null : new Date(now + parsed.data.expiresInDays * DAY_MS).toISOString(),
    })
    .select(LINK_COLUMNS)
    .single<LinkRow>();
  if (error) return fail(error.code === FK_VIOLATION ? "not_found" : "failed");

  await logEvent({
    event: "share.created",
    userId: session.userId,
    props: { linkId: data.id, expiresInDays: parsed.data.expiresInDays, includeItems },
  });
  return { ok: true, data: { link: rowToLink(data), url: `${base}/${planLocale}/s/${token}` } };
}

export async function revokeShareLink(id: string): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");
  const { data, error } = await session.supabase.from("share_links").delete().eq("id", id).select("id");
  if (error) return fail("failed");
  if (!data || data.length === 0) return fail("not_found");
  await logEvent({ event: "share.revoked", userId: session.userId, props: { linkId: id } });
  // Fresh RSC payload in the action response; router.refresh() alone was occasionally stale (E2E flake).
  revalidatePath("/[locale]/app/trips/[id]", "page");
  return { ok: true };
}
