"use server";

// Phase-3 step-0 stub: returns fixture states so the UI can be built before the store lands.
// backend-dev replaces the bodies (spec 5.1); signatures are the contract.

import { z } from "zod";
import { Plan, PlanEdit, type PlanState } from "@/lib/domain/plan";
import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
import stateFixture from "@/lib/plan/__fixtures__/plan-state-outdated.json";
import { getUserSession } from "./session";

const Id = z.string().uuid();

function fixtureState(tripId: string, version?: number): PlanState {
  const raw = stateFixture as unknown as PlanState;
  const plan = Plan.parse(raw.version?.plan);
  const meta = raw.versions.find((m) => m.versionNo === version) ?? raw.versions[0];
  return {
    ...raw,
    tripId,
    version: { meta, plan },
    isLatest: meta.versionNo === raw.versions[0].versionNo,
  };
}

export async function getPlanState(tripId: string, version?: number): Promise<ActionResult<PlanState>> {
  if (!(await getUserSession())) return fail("unauthenticated");
  if (!Id.safeParse(tripId).success) return fail("not_found");
  return { ok: true, data: fixtureState(tripId, version) };
}

export async function editPlan(
  tripId: string,
  baseVersion: number,
  edit: PlanEdit,
): Promise<ActionResult<PlanState>> {
  if (!(await getUserSession())) return fail("unauthenticated");
  if (!Id.safeParse(tripId).success) return fail("not_found");
  const parsed = PlanEdit.safeParse(edit);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  void baseVersion;
  return { ok: true, data: fixtureState(tripId) };
}

export async function restorePlanVersion(tripId: string, versionNo: number): Promise<ActionResult<PlanState>> {
  if (!(await getUserSession())) return fail("unauthenticated");
  if (!Id.safeParse(tripId).success) return fail("not_found");
  if (!z.number().int().min(1).safeParse(versionNo).success) return fail("invalid");
  return { ok: true, data: fixtureState(tripId) };
}
