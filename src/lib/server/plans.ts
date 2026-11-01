"use server";

import { z } from "zod";
import type { PlanEdit, PlanState } from "@/lib/domain/plan";
import { fail, type ActionResult } from "@/lib/domain/result";
import type { SupabaseClient } from "@supabase/supabase-js";
import { openItemKey } from "@/lib/plan/open-items";
import { getVersionLight } from "./plan-store";
import { getUserSession } from "./session";
import { editPlanVersion, loadPlanContext, loadPlanState, restoreVersion } from "./plan-pipeline";

const Version = z.number().int().min(1);

/** State of the trip's plan (requested ?v= version or latest). Generation and iteration run via the route handlers. */
export async function getPlanState(tripId: string, version?: number): Promise<ActionResult<PlanState>> {
  if (version !== undefined && !Version.safeParse(version).success) return fail("invalid");
  const loaded = await loadPlanContext(tripId);
  if (!loaded.ok) return fail(loaded.error);
  const s = await loadPlanState(loaded.ctx, version);
  return s.ok ? { ok: true, data: s.state } : fail(s.error);
}

/** Code-only edit (swap days, best day). No AI, no budget. */
export async function editPlan(tripId: string, baseVersion: number, edit: PlanEdit): Promise<ActionResult<PlanState>> {
  const res = await editPlanVersion(tripId, baseVersion, edit);
  return res.ok ? { ok: true, data: res.data.state } : fail(res.error, res.issues);
}

/** Restores an older version as a new version. No AI, no budget. */
export async function restorePlanVersion(tripId: string, versionNo: number): Promise<ActionResult<PlanState>> {
  const res = await restoreVersion(tripId, versionNo);
  return res.ok ? { ok: true, data: res.data.state } : fail(res.error, res.issues);
}

const OpenKey = z.string().regex(/^[0-9a-f]{8}$/);
const MAX_OPEN_DONE = 50;

/** Ticks/unticks one open item of the latest plan. Stored as keys (`openItemKey`); keys no longer in the plan are dropped. */
export async function toggleOpenItem(tripId: string, key: string, done: boolean): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!z.string().uuid().safeParse(tripId).success || !OpenKey.safeParse(key).success || typeof done !== "boolean") {
    return fail("invalid");
  }
  const sb = session.supabase;
  const { data: row, error } = await sb
    .from("plans")
    .select("id, latest_version, open_done")
    .eq("trip_id", tripId)
    .maybeSingle<{ id: string; latest_version: number; open_done: string[] }>();
  if (error) return fail("failed");
  if (!row) return fail("not_found");
  if (row.latest_version < 1) return fail("no_plan");
  let version;
  try {
    version = await getVersionLight(sb as SupabaseClient, row.id, row.latest_version);
  } catch {
    return fail("failed");
  }
  if (!version) return fail("failed");
  const valid = new Set(version.plan.openItems.map((o) => openItemKey(o.text)));
  if (!valid.has(key)) return fail("not_found");
  const next = new Set((row.open_done ?? []).filter((k) => valid.has(k)));
  if (done) next.add(key);
  else next.delete(key);
  const open_done = [...next].slice(0, MAX_OPEN_DONE);
  const { error: updateError } = await sb.from("plans").update({ open_done }).eq("id", row.id);
  return updateError ? fail("failed") : { ok: true };
}
