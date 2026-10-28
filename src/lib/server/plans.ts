"use server";

import { z } from "zod";
import type { PlanEdit, PlanState } from "@/lib/domain/plan";
import { fail, type ActionResult } from "@/lib/domain/result";
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
