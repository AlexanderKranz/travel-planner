import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Plan, PlanFlights } from "@/lib/domain/plan";
import type { SharedItem } from "@/lib/domain/items";
import type { PlanDocument } from "@/lib/domain/share";
import { berlinToday } from "@/lib/date";
import { groupPartySize, resolveGroup, tripGroupSource, type GroupSource } from "@/lib/group-text";
import { computeCosts } from "@/lib/items/costs";
import { cachedParse } from "./group-mapping";
import { rowToGroupStructure, type TripRow } from "./trip-mapping";
import { logEvent } from "./events";
import {
  ITEM_COLUMNS,
  SHARED_ITEM_COLUMNS,
  rowToSharedItem,
  type ItemRow,
  type SharedItemRow,
} from "./item-mapping";
import { getUserSession } from "./session";
import { itemsChangedSince } from "@/lib/plan/fixed-items";
import { createSupabaseAdminClient } from "./supabase/admin";
import { hashShareToken, isShareTokenFormat } from "./share-token";

const Id_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PlanDocumentParts = {
  plan: Plan;
  versionNo: number;
  versionAt: string;
  openDone: string[];
  /** null = items not part of this document. */
  items: SharedItem[] | null;
  partySize: number | null;
};

/** Pure. Reserved plan keys `items`/`costs` are dropped (items live in trip_items); costs are computed here. */
export function buildPlanDocument(parts: PlanDocumentParts): PlanDocument {
  const { items: _items, costs: _costs, ...plan } = parts.plan;
  void _items;
  void _costs;
  return {
    plan: plan as Plan,
    versionNo: parts.versionNo,
    versionAt: parts.versionAt,
    openDone: parts.openDone,
    items: parts.items,
    costs: parts.items ? computeCosts(parts.items, parts.partySize) : null,
  };
}

const PARTY_TRIP_COLUMNS = "group_id, group_text, group_structure, group_parsed, group_parsed_hash";
type PartyTripRow = Pick<TripRow, "group_id" | "group_text" | "group_structure" | "group_parsed" | "group_parsed_hash">;

/**
 * Party size from the same resolution as the plan input (saved entries > parse > text only), see lib/group-text.
 * Explicit column lists: only what the count needs (the shared path calls this with the secret key).
 */
async function loadPartySize(sb: SupabaseClient, tripId: string): Promise<number | null> {
  const { data: row, error } = await sb.from("trips").select(PARTY_TRIP_COLUMNS).eq("id", tripId).maybeSingle<PartyTripRow>();
  if (error) throw new Error("trip read failed");
  if (!row) return null;
  let source: GroupSource | null = tripGroupSource({
    groupText: row.group_text ?? undefined,
    groupStructure: rowToGroupStructure(row.group_structure),
    groupParse: cachedParse(row.group_text, row.group_parsed, row.group_parsed_hash),
  });
  if (row.group_id) {
    const [{ data: g, error: e1 }, { data: entries, error: e2 }] = await Promise.all([
      sb.from("travel_groups").select("description, parsed_structure, parsed_hash").eq("id", row.group_id).maybeSingle<{ description: string | null; parsed_structure: unknown; parsed_hash: string | null }>(),
      sb.from("group_entries").select("kind, count").eq("group_id", row.group_id).returns<{ kind: "composition" | "member"; count: number }[]>(),
    ]);
    if (e1 || e2) throw new Error("group read failed");
    source = g
      ? {
          entries: entries.map((e) => ({ kind: e.kind, count: e.count })),
          traitKeys: [],
          description: g.description ?? undefined,
          parse: cachedParse(g.description, g.parsed_structure, g.parsed_hash),
        }
      : null;
  }
  // Counts do not depend on ages, so any date will do.
  return source ? groupPartySize(resolveGroup(source, berlinToday())) : null;
}

type OwnerError = "unauthenticated" | "not_found" | "no_plan" | "failed";

/** Owner read with the user session (RLS). Always the latest version, all item notes. */
export async function getOwnerPlanDocumentResult(
  tripId: string,
): Promise<{ ok: true; doc: PlanDocument } | { ok: false; error: OwnerError }> {
  const session = await getUserSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!Id_RE.test(tripId)) return { ok: false, error: "not_found" };
  const sb = session.supabase;
  try {
    const { data: trip, error: tripErr } = await sb.from("trips").select("id").eq("id", tripId).maybeSingle();
    if (tripErr) return { ok: false, error: "failed" };
    if (!trip) return { ok: false, error: "not_found" };
    const { data: planRow, error: planErr } = await sb
      .from("plans")
      .select("id, latest_version, open_done")
      .eq("trip_id", tripId)
      .maybeSingle<{ id: string; latest_version: number; open_done: string[] }>();
    if (planErr) return { ok: false, error: "failed" };
    if (!planRow || planRow.latest_version < 1) return { ok: false, error: "no_plan" };
    const { data: ver, error: verErr } = await sb
      .from("plan_versions")
      .select("plan, version_no, created_at")
      .eq("plan_id", planRow.id)
      .eq("version_no", planRow.latest_version)
      .maybeSingle<{ plan: unknown; version_no: number; created_at: string }>();
    if (verErr) return { ok: false, error: "failed" };
    const plan = Plan.safeParse(ver?.plan);
    if (!ver || !plan.success) return { ok: false, error: "failed" };
    const { data: rows, error: itemErr } = await sb
      .from("trip_items")
      .select(ITEM_COLUMNS)
      .eq("trip_id", tripId)
      .order("day", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .returns<ItemRow[]>();
    if (itemErr) return { ok: false, error: "failed" };
    const items = rows.map((r) => rowToSharedItem(r, true));
    const doc = buildPlanDocument({
      plan: plan.data,
      versionNo: ver.version_no,
      versionAt: ver.created_at,
      openDone: planRow.open_done ?? [],
      items,
      partySize: await loadPartySize(sb, tripId),
    });
    const timed = rows.map((r) => ({ day: r.day, startTime: r.start_time, updatedAt: r.updated_at }));
    return { ok: true, doc: { ...doc, itemsChanged: itemsChangedSince(timed, ver.created_at) } };
  } catch {
    return { ok: false, error: "failed" };
  }
}

export async function getOwnerPlanDocument(tripId: string): Promise<PlanDocument | null> {
  const res = await getOwnerPlanDocumentResult(tripId);
  return res.ok ? res.doc : null;
}

/**
 * PUBLIC read path of share links. This is the ONE place that reads user content with the secret key (RLS bypass),
 * because the visitor has no session: access is granted by possession of the token (only its sha256 is stored).
 * Rules: explicit column lists (never `*`); no emails, names, birthdates, trip notes, group/purpose text, version
 * history or plan input; item notes only when the link has include_item_notes; every failure returns null so the
 * caller renders one identical 404 (no oracle between unknown, expired, revoked, no plan). No external API calls.
 * Unknown tokens are not logged. Tokens, hashes and IPs never go into events.
 */
export async function getSharedPlanDocument(token: string, via: "page" | "pdf"): Promise<PlanDocument | null> {
  if (!isShareTokenFormat(token)) return null;
  try {
    const admin = createSupabaseAdminClient();
    const { data: link, error } = await admin
      .from("share_links")
      .select("id, owner_id, trip_id, include_items, include_item_notes, expires_at")
      .eq("token_hash", hashShareToken(token))
      .maybeSingle<{
        id: string;
        owner_id: string;
        trip_id: string;
        include_items: boolean;
        include_item_notes: boolean;
        expires_at: string | null;
      }>();
    if (error || !link) return null;
    if (link.expires_at !== null && Date.parse(link.expires_at) <= Date.now()) return null;

    const { data: planRow, error: planErr } = await admin
      .from("plans")
      .select("id, latest_version, open_done")
      .eq("trip_id", link.trip_id)
      .maybeSingle<{ id: string; latest_version: number; open_done: string[] }>();
    if (planErr || !planRow || planRow.latest_version < 1) return null;

    const { data: ver, error: verErr } = await admin
      .from("plan_versions")
      .select("plan, version_no, created_at")
      .eq("plan_id", planRow.id)
      .eq("version_no", planRow.latest_version)
      .maybeSingle<{ plan: unknown; version_no: number; created_at: string }>();
    if (verErr || !ver) return null;
    const plan = Plan.safeParse(ver.plan);
    if (!plan.success) {
      await logEvent({ event: "share.invalid_plan", level: "error", userId: link.owner_id, props: { linkId: link.id } });
      return null;
    }

    let items: SharedItem[] | null = null;
    let party: number | null = null;
    if (link.include_items) {
      const columns = link.include_item_notes ? `${SHARED_ITEM_COLUMNS}, notes` : SHARED_ITEM_COLUMNS;
      const { data: rows, error: itemErr } = await admin
        .from("trip_items")
        .select(columns)
        .eq("trip_id", link.trip_id)
        .order("day", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true })
        .returns<SharedItemRow[]>();
      if (itemErr) return null;
      items = rows.map((r) => rowToSharedItem(r, link.include_item_notes));
      party = await loadPartySize(admin, link.trip_id);
    }

    await Promise.allSettled([
      Promise.resolve(admin.rpc("share_link_touch", { p_id: link.id })),
      logEvent({ event: "share.viewed", userId: link.owner_id, props: { linkId: link.id, via } }),
    ]);

    return buildPlanDocument({
      plan: plan.data,
      versionNo: ver.version_no,
      versionAt: ver.created_at,
      openDone: planRow.open_done ?? [],
      items,
      partySize: party,
    });
  } catch {
    return null;
  }
}

/**
 * Verified flight legs of the latest plan version (owner, RLS), for the flight select in the item form.
 * Reads only `plan->flights`. Empty on any error or when the plan has no flights.
 */
export async function getOwnerPlanFlights(tripId: string): Promise<PlanFlights | null> {
  const session = await getUserSession();
  if (!session || !Id_RE.test(tripId)) return null;
  try {
    const sb = session.supabase;
    const { data: planRow } = await sb
      .from("plans")
      .select("id, latest_version")
      .eq("trip_id", tripId)
      .maybeSingle<{ id: string; latest_version: number }>();
    if (!planRow || planRow.latest_version < 1) return null;
    const { data } = await sb
      .from("plan_versions")
      .select("flights:plan->flights")
      .eq("plan_id", planRow.id)
      .eq("version_no", planRow.latest_version)
      .maybeSingle<{ flights: unknown }>();
    const parsed = PlanFlights.safeParse(data?.flights);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
