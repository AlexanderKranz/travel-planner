import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  MAX_VERSIONS_KEPT,
  OsmKey,
  Plan,
  PlanEdit,
  PlanFeedback,
  PlanPlace,
  type PlanVersionKind,
  type PlanVersionMeta,
  type PurposeTags,
} from "@/lib/domain/plan";
import type { PlanInputStored } from "@/lib/plan/input";
import { createSupabaseAdminClient } from "./supabase/admin";

/** Plan persistence with the USER session (RLS applies) [D2]. Only savePurposeTags uses the secret key. */

export const LOCK_MS = 5 * 60_000;
const UNIQUE_VIOLATION = "23505";

export type PlanRow = { id: string; latestVersion: number; busyUntil: string | null; updatedAt: string };

export type StoredVersion = {
  meta: PlanVersionMeta;
  plan: Plan;
  input: PlanInputStored;
  inputHash: string;
  costMicroUsd: number;
};

export type NewVersion = {
  kind: PlanVersionKind;
  plan: Plan;
  input: PlanInputStored;
  inputHash: string;
  feedback?: PlanFeedback | PlanEdit | null;
  restoredFrom?: number | null;
  changedDays?: number[];
  model?: string | null;
  costMicroUsd?: number;
};

const StoredInput = z.object({
  llm: z.looseObject({ v: z.literal(1) }),
  index: z.record(z.string(), z.object({ key: OsmKey, place: PlanPlace })),
});

const META_COLUMNS = "version_no, kind, created_at, feedback, restored_from, changed_days, model";
const FULL_COLUMNS = `${META_COLUMNS}, plan, input, input_hash, cost_micro_usd`;

type MetaRow = {
  version_no: number;
  kind: PlanVersionKind;
  created_at: string;
  feedback: unknown;
  restored_from: number | null;
  changed_days: number[] | null;
  model: string | null;
};
type FullRow = MetaRow & { plan: unknown; input: unknown; input_hash: string; cost_micro_usd: number };

const FeedbackOrEdit = z.union([PlanEdit, PlanFeedback]);

export function rowToMeta(r: MetaRow): PlanVersionMeta {
  const fb = r.feedback == null ? null : FeedbackOrEdit.safeParse(r.feedback);
  return {
    versionNo: r.version_no,
    kind: r.kind,
    createdAt: r.created_at,
    feedback: fb && fb.success ? fb.data : null,
    restoredFrom: r.restored_from,
    changedDays: r.changed_days ?? [],
    model: r.model,
  };
}

function rowToVersion(r: FullRow): StoredVersion | null {
  const plan = Plan.safeParse(r.plan);
  const input = StoredInput.safeParse(r.input);
  if (!plan.success || !input.success) return null;
  return {
    meta: rowToMeta(r),
    plan: plan.data,
    input: input.data as PlanInputStored,
    inputHash: r.input_hash,
    costMicroUsd: r.cost_micro_usd,
  };
}

type PlanRowDb = { id: string; latest_version: number; busy_until: string | null; updated_at: string };
const toPlanRow = (r: PlanRowDb): PlanRow => ({
  id: r.id,
  latestVersion: r.latest_version,
  busyUntil: r.busy_until,
  updatedAt: r.updated_at,
});
const PLAN_COLUMNS = "id, latest_version, busy_until, updated_at";

export function isBusy(row: Pick<PlanRow, "busyUntil"> | null, now: number = Date.now()): boolean {
  return !!row?.busyUntil && Date.parse(row.busyUntil) > now;
}

export async function getPlanRow(sb: SupabaseClient, tripId: string): Promise<PlanRow | null> {
  const { data, error } = await sb.from("plans").select(PLAN_COLUMNS).eq("trip_id", tripId).maybeSingle<PlanRowDb>();
  if (error) throw new Error("plan read failed");
  return data ? toPlanRow(data) : null;
}

/** Existing plan row or a new one (one per trip). owner_id comes from its column default; RLS + composite FK check the trip. */
export async function ensurePlan(sb: SupabaseClient, tripId: string): Promise<PlanRow> {
  const existing = await getPlanRow(sb, tripId);
  if (existing) return existing;
  const { data, error } = await sb.from("plans").insert({ trip_id: tripId }).select(PLAN_COLUMNS).single<PlanRowDb>();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      const again = await getPlanRow(sb, tripId);
      if (again) return again;
    }
    throw new Error("plan create failed");
  }
  return toPlanRow(data);
}

/** Newest first. */
export async function listVersionMetas(sb: SupabaseClient, planId: string): Promise<PlanVersionMeta[]> {
  const { data, error } = await sb
    .from("plan_versions")
    .select(META_COLUMNS)
    .eq("plan_id", planId)
    .order("version_no", { ascending: false })
    .limit(MAX_VERSIONS_KEPT + 5)
    .returns<MetaRow[]>();
  if (error) throw new Error("versions read failed");
  return data.map(rowToMeta);
}

export async function getVersion(sb: SupabaseClient, planId: string, versionNo: number): Promise<StoredVersion | null> {
  const { data, error } = await sb
    .from("plan_versions")
    .select(FULL_COLUMNS)
    .eq("plan_id", planId)
    .eq("version_no", versionNo)
    .maybeSingle<FullRow>();
  if (error) throw new Error("version read failed");
  return data ? rowToVersion(data) : null;
}

/** Newest version with this input hash, if any. */
export async function findVersionByHash(sb: SupabaseClient, planId: string, hash: string): Promise<StoredVersion | null> {
  const { data, error } = await sb
    .from("plan_versions")
    .select(FULL_COLUMNS)
    .eq("plan_id", planId)
    .eq("input_hash", hash)
    .order("version_no", { ascending: false })
    .limit(1)
    .returns<FullRow[]>();
  if (error) throw new Error("version read failed");
  return data[0] ? rowToVersion(data[0]) : null;
}

/** Appends a version; version_no is assigned by the DB trigger. Returns the new number. */
export async function insertVersion(sb: SupabaseClient, planId: string, v: NewVersion): Promise<number> {
  const { data, error } = await sb
    .from("plan_versions")
    .insert({
      plan_id: planId,
      kind: v.kind,
      plan: v.plan,
      input: v.input,
      input_hash: v.inputHash,
      feedback: v.feedback ?? null,
      restored_from: v.restoredFrom ?? null,
      changed_days: v.changedDays ?? [],
      model: v.model ?? null,
      cost_micro_usd: Math.max(0, Math.round(v.costMicroUsd ?? 0)),
    })
    .select("version_no")
    .single<{ version_no: number }>();
  if (error) throw new Error("version insert failed");
  return data.version_no;
}

/** Keeps the last MAX_VERSIONS_KEPT versions [D3]. Best effort. */
export async function pruneVersions(sb: SupabaseClient, planId: string, latestVersion: number): Promise<void> {
  const cutoff = latestVersion - MAX_VERSIONS_KEPT;
  if (cutoff < 1) return;
  await sb.from("plan_versions").delete().eq("plan_id", planId).lte("version_no", cutoff);
}

/** Generation lock: true when this call took it. */
export async function acquireLock(sb: SupabaseClient, planId: string, now: number = Date.now()): Promise<boolean> {
  const { data, error } = await sb
    .from("plans")
    .update({ busy_until: new Date(now + LOCK_MS).toISOString() })
    .eq("id", planId)
    .or(`busy_until.is.null,busy_until.lt.${new Date(now).toISOString()}`)
    .select("id");
  if (error) throw new Error("lock failed");
  return data.length === 1;
}

export async function releaseLock(sb: SupabaseClient, planId: string): Promise<void> {
  try {
    await sb.from("plans").update({ busy_until: null }).eq("id", planId);
  } catch {
    // the lock expires on its own after LOCK_MS
  }
}

/**
 * Caches Haiku tags on the purpose. SECRET KEY (RLS bypass) on purpose: users have no grant on parsed_*.
 * The owner_id filter keeps the write scoped to the requesting user's own purpose.
 */
export async function savePurposeTags(
  userId: string,
  purposeId: string,
  tags: PurposeTags,
  hash: string,
): Promise<{ updatedAt: string } | null> {
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("trip_purposes")
      .update({ parsed_tags: tags, parsed_hash: hash, parsed_at: new Date().toISOString() })
      .eq("id", purposeId)
      .eq("owner_id", userId)
      .select("updated_at");
    // The updated_at trigger moves purpose.updatedAt; callers must use the returned value so the plan basis stays current.
    return !error && data.length === 1 ? { updatedAt: data[0].updated_at as string } : null;
  } catch {
    return null;
  }
}
