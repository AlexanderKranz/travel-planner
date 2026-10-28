import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { berlinToday } from "@/lib/date";
import { MODEL_PLAN, type AiCtx } from "@/lib/domain/ai";
import type { TravelGroup } from "@/lib/domain/group";
import {
  MAX_PLAN_DAYS,
  Plan,
  PlanEdit,
  PlanFeedback,
  isPlanOutdated,
  type PlanState,
} from "@/lib/domain/plan";
import type { Locale } from "@/lib/domain/profile";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { ActionError } from "@/lib/domain/result";
import type { Trip } from "@/lib/domain/trip";
import { applyEdit } from "@/lib/plan/edit";
import { canonicalJson, planInputHash, purposeTagsHash } from "@/lib/plan/hash";
import { buildPlanInput } from "@/lib/plan/input";
import { applyPatch } from "@/lib/plan/patch";
import { assemblePlan } from "@/lib/plan/assemble";
import { composePlan, patchPlan } from "./ai/compose";
import { needsTags, tagPurpose } from "./ai/purpose-tags";
import { berlinMidnight, budgetAllows, getBudgetStatus, isAiEnabled, logAiUsage, userCapMicroUsd, type BudgetInfo, type Role } from "./ai-usage";
import { logEvent } from "./events";
import { getTripFacts } from "./facts";
import { getGroup } from "./groups";
import {
  acquireLock,
  ensurePlan,
  findVersionByHash,
  getPlanRow,
  getVersion,
  insertVersion,
  isBusy,
  hasBusyPlan,
  listVersionMetas,
  pruneVersions,
  releaseLock,
  savePurposeTags,
  type PlanRow,
  type StoredVersion,
} from "./plan-store";
import { getProfile } from "./profile";
import { getPurpose } from "./purposes";
import { rateLimit } from "./rate-limit";
import { getUserSession } from "./session";
import { getTrip } from "./trips";

const PLACES_BUDGET_MS = 30_000;
const RESERVE_TAGS = 2_000;
const RESERVE_GENERATE = 150_000;
const RESERVE_PATCH = 50_000;
const Id = z.string().uuid();

export type PipelineData = { state: PlanState; unchanged?: true; reply?: string };
export type PipelineError = {
  ok: false;
  error: ActionError;
  resetAt?: string;
  retryAfter?: number;
  issues?: { path: string; message: string }[];
};
export type PipelineResult = { ok: true; data: PipelineData } | PipelineError;

type Session = NonNullable<Awaited<ReturnType<typeof getUserSession>>>;
export type PlanContext = {
  session: Session;
  sb: SupabaseClient;
  role: Role;
  isDemo: boolean;
  birthdate: string | null;
  trip: Trip;
  group: TravelGroup | null;
  purpose: TripPurpose | null;
};

const err = (error: ActionError, extra: Partial<PipelineError> = {}): PipelineError => ({ ok: false, error, ...extra });

/** Session, profile, trip (RLS), group, purpose. */
export async function loadPlanContext(tripId: string): Promise<{ ok: true; ctx: PlanContext } | PipelineError> {
  const session = await getUserSession();
  if (!session) return err("unauthenticated");
  if (!Id.safeParse(tripId).success) return err("not_found");
  const [profile, tripRes] = await Promise.all([getProfile(), getTrip(tripId)]);
  if (!tripRes.ok) return err(tripRes.error === "not_found" || tripRes.error === "invalid" ? "not_found" : "failed");
  if (!profile.ok) return err("failed");
  const trip = tripRes.data;
  let group: TravelGroup | null = null;
  let purpose: TripPurpose | null = null;
  if (trip.groupId) {
    const g = await getGroup(trip.groupId);
    if (g.ok) group = g.data;
  }
  if (trip.purposeId) {
    const p = await getPurpose(trip.purposeId);
    if (p.ok) purpose = p.data;
  }
  return {
    ok: true,
    ctx: {
      session,
      sb: session.supabase as SupabaseClient,
      role: profile.data.role,
      isDemo: profile.data.isDemo,
      birthdate: profile.data.birthdate,
      trip,
      group,
      purpose,
    },
  };
}

/** Budget status; fails closed (spent = cap) when ai_usage cannot be read. */
async function budgetInfo(c: PlanContext): Promise<BudgetInfo> {
  try {
    return await getBudgetStatus(c.session.userId, c.role, c.isDemo);
  } catch {
    const cap = userCapMicroUsd(c.role, c.isDemo);
    return {
      spentMicroUsd: cap,
      capMicroUsd: cap,
      resetsAt: berlinMidnight(new Date(), 1).toISOString(),
      globalSpentMicroUsd: 1,
      globalCapMicroUsd: 0,
    };
  }
}

async function checkBudget(c: PlanContext, reserve: number): Promise<PipelineError | null> {
  const info = await budgetInfo(c);
  return budgetAllows(info, reserve) ? null : err("budget_exceeded", { resetAt: info.resetsAt });
}

function startDateOf(trip: Trip): string | null {
  return trip.timing.kind === "date" ? trip.timing.startDate : null;
}

export function computeCanIterate(plan: Plan, trip: Trip, isLatest: boolean, aiEnabled: boolean): boolean {
  const t = plan.header.timing;
  const planStart = t.kind === "date" ? t.startDate : null;
  return isLatest && aiEnabled && plan.days.length === trip.lengthDays && planStart === startDateOf(trip);
}

/** PlanState for the requested (or latest) version. `not_found` when the requested version does not exist. */
export async function loadPlanState(
  c: PlanContext,
  requested?: number,
): Promise<{ ok: true; state: PlanState } | PipelineError> {
  try {
    const row = await getPlanRow(c.sb, c.trip.id);
    const versions = row ? await listVersionMetas(c.sb, row.id) : [];
    const aiEnabled = isAiEnabled();
    const busy = isBusy(row);
    // While busy the client only polls for completion: skip the two admin aggregate queries (budget is static then).
    const info = busy
      ? { spentMicroUsd: 0, capMicroUsd: userCapMicroUsd(c.role, c.isDemo), resetsAt: berlinMidnight(new Date(), 1).toISOString(), globalSpentMicroUsd: 0, globalCapMicroUsd: 1 }
      : await budgetInfo(c);
    const exhausted = info.globalSpentMicroUsd >= info.globalCapMicroUsd;
    const budget = {
      spentMicroUsd: exhausted ? info.capMicroUsd : info.spentMicroUsd,
      capMicroUsd: info.capMicroUsd,
      resetsAt: info.resetsAt,
    };
    const base = { tripId: c.trip.id, versions, busy, aiEnabled, budget };
    if (!row || versions.length === 0) {
      if (requested !== undefined) return err("not_found");
      return { ok: true, state: { ...base, version: null, isLatest: true, outdated: false, canIterate: false } };
    }
    const wanted = requested ?? versions[0].versionNo;
    const meta = versions.find((m) => m.versionNo === wanted);
    if (!meta) return err("not_found");
    const stored = await getVersion(c.sb, row.id, wanted);
    if (!stored) return err("failed");
    const isLatest = wanted === versions[0].versionNo;
    return {
      ok: true,
      state: {
        ...base,
        version: { meta: stored.meta, plan: stored.plan },
        isLatest,
        outdated: isPlanOutdated(stored.plan.header.basis, {
          tripUpdatedAt: c.trip.updatedAt,
          groupUpdatedAt: c.group?.updatedAt ?? null,
          purposeUpdatedAt: c.purpose?.updatedAt ?? null,
        }),
        canIterate: computeCanIterate(stored.plan, c.trip, isLatest, aiEnabled),
      },
    };
  } catch {
    return err("failed");
  }
}

async function done(c: PlanContext, extra: Omit<PipelineData, "state"> = {}): Promise<PipelineResult> {
  const s = await loadPlanState(c);
  return s.ok ? { ok: true, data: { state: s.state, ...extra } } : s;
}

function makeAiCtx(c: PlanContext) {
  let cost = 0;
  const ctx: AiCtx = {
    onUsage: async (u) => {
      cost += u.costMicroUsd;
      await logAiUsage(c.session.userId, c.isDemo, u);
    },
  };
  return { ctx, cost: () => cost };
}

async function failed(c: PlanContext, reason: string, error: ActionError, extra: Partial<PipelineError> = {}) {
  await logEvent({ event: "plan.failed", level: "warn", userId: c.session.userId, props: { tripId: c.trip.id, reason } });
  return err(error, extra);
}

function diffDays(a: Plan, b: Plan): number[] {
  const byN = (p: Plan) => new Map(p.days.map((d) => [d.n, canonicalJson(d)]));
  const ma = byN(a);
  const mb = byN(b);
  const out: number[] = [];
  for (const [n, json] of mb) if (ma.get(n) !== json) out.push(n);
  return out.sort((x, y) => x - y);
}

/** Common gate: rate limit + AI switch. */
function gate(userId: string): PipelineError | null {
  const rl = rateLimit(`plan:${userId}`, 2, 60_000);
  if (!rl.ok) return err("rate_limited", { retryAfter: rl.retryAfterSeconds });
  if (!isAiEnabled()) return err("ai_disabled");
  return null;
}

export async function generatePlan(tripId: string, locale: Locale): Promise<PipelineResult> {
  const loaded = await loadPlanContext(tripId);
  if (!loaded.ok) return loaded;
  const c = loaded.ctx;
  const g = gate(c.session.userId);
  if (g) return g;
  if (c.trip.lengthDays > MAX_PLAN_DAYS) return err("too_long");

  const started = Date.now();
  const ai = makeAiCtx(c);
  let plan: PlanRow | null = null;
  let locked = false;
  try {
    // Per-user in-flight guard: parallel requests could otherwise all pass the budget check (spend is recorded late).
    if (await hasBusyPlan(c.sb)) return err("busy");
    // 3. Haiku tags (once per purpose content, cached in parsed_*)
    let purpose = c.purpose;
    if (purpose && purpose.tags == null && needsTags(purpose)) {
      const blocked = await checkBudget(c, RESERVE_TAGS);
      if (blocked) return blocked;
      const res = await tagPurpose(purpose, ai.ctx);
      if (res.ok) {
        const saved = await savePurposeTags(c.session.userId, purpose.id, res.data, purposeTagsHash(purpose));
        // The save moves purpose.updated_at (trigger); use the new value so the plan basis stays current.
        purpose = { ...purpose, tags: res.data, updatedAt: saved?.updatedAt ?? purpose.updatedAt };
      } else {
        await logEvent({ event: "purpose.tag_failed", level: "warn", userId: c.session.userId, props: { purposeId: purpose.id, reason: res.error } });
      }
    }

    // 4. facts + input
    const facts = await getTripFacts(
      c.trip,
      purpose,
      { userId: c.session.userId, locale, today: berlinToday() },
      { placesBudgetMs: PLACES_BUDGET_MS },
    );
    const built = buildPlanInput({
      trip: c.trip,
      group: c.group,
      purpose,
      profileBirthdate: c.birthdate,
      facts,
      locale,
      today: berlinToday(),
    });
    const inputHash = planInputHash(built.stored.llm);

    // 5. dedupe (D13)
    plan = await ensurePlan(c.sb, c.trip.id);
    const latest = plan.latestVersion > 0 ? await getVersion(c.sb, plan.id, plan.latestVersion) : null;
    if (isBusy(plan)) return err("busy");
    const hit = latest?.inputHash === inputHash ? latest : await findVersionByHash(c.sb, plan.id, inputHash);
    if (hit) {
      const refreshed = Plan.safeParse({ ...hit.plan, header: { ...hit.plan.header, ...built.header } });
      if (refreshed.success) {
        const sameBasis = canonicalJson(refreshed.data.header) === canonicalJson(hit.plan.header);
        if (hit.meta.versionNo === latest?.meta.versionNo && sameBasis) {
          await logEvent({ event: "plan.generated", userId: c.session.userId, props: { tripId: c.trip.id, days: hit.plan.days.length, cached: true, unchanged: true, costMicroUsd: ai.cost() } });
          return await done(c, { unchanged: true });
        }
        // Same input as an earlier version (or only the trip/group header changed): new version, no AI call.
        const no = await insertVersion(c.sb, plan.id, {
          kind: "restore",
          plan: refreshed.data,
          input: hit.input,
          inputHash,
          restoredFrom: hit.meta.versionNo,
          changedDays: latest ? diffDays(latest.plan, refreshed.data) : [],
          costMicroUsd: ai.cost(),
        });
        await pruneVersions(c.sb, plan.id, no);
        await logEvent({ event: "plan.generated", userId: c.session.userId, props: { tripId: c.trip.id, days: refreshed.data.days.length, cached: true, durationMs: Date.now() - started, costMicroUsd: ai.cost() } });
        return await done(c);
      }
    }

    // 6. budget
    const blocked = await checkBudget(c, RESERVE_GENERATE);
    if (blocked) return blocked;

    // 7. lock
    if (!(await acquireLock(c.sb, plan.id))) return err("busy");
    locked = true;

    // 8. compose
    const res = await composePlan(built.stored.llm, ai.ctx);
    if (!res.ok) return failed(c, res.error, res.error);
    const assembled = assemblePlan({
      llm: res.data,
      stored: built.stored,
      header: { ...built.header, generatedAt: new Date().toISOString(), model: MODEL_PLAN },
      digest: built.digest,
      locale,
    });
    if (!assembled.ok) return failed(c, assembled.reason, "invalid_output");
    const parsed = Plan.safeParse(assembled.plan);
    if (!parsed.success) return failed(c, "schema", "invalid_output");

    const no = await insertVersion(c.sb, plan.id, {
      kind: "generate",
      plan: parsed.data,
      input: built.stored,
      inputHash,
      model: MODEL_PLAN,
      costMicroUsd: ai.cost(),
    });
    await pruneVersions(c.sb, plan.id, no);
    await logEvent({
      event: "plan.generated",
      userId: c.session.userId,
      props: { tripId: c.trip.id, days: parsed.data.days.length, durationMs: Date.now() - started, costMicroUsd: ai.cost(), cached: false, ...assembled.issues },
    });
    return await done(c);
  } catch {
    return failed(c, "exception", "failed");
  } finally {
    if (locked && plan) await releaseLock(c.sb, plan.id);
  }
}

export async function iteratePlan(
  tripId: string,
  baseVersion: number,
  feedback: unknown,
  locale: Locale,
): Promise<PipelineResult> {
  void locale; // iterations keep the plan language [D15]
  const loaded = await loadPlanContext(tripId);
  if (!loaded.ok) return loaded;
  const c = loaded.ctx;
  const fb = PlanFeedback.safeParse(feedback);
  if (!fb.success || !z.number().int().min(1).safeParse(baseVersion).success) {
    return err("invalid", fb.success ? undefined : { issues: fb.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });
  }
  const g = gate(c.session.userId);
  if (g) return g;
  if (c.trip.lengthDays > MAX_PLAN_DAYS) return err("too_long");

  const started = Date.now();
  const ai = makeAiCtx(c);
  let plan: PlanRow | null = null;
  let locked = false;
  try {
    if (await hasBusyPlan(c.sb)) return err("busy");
    plan = await getPlanRow(c.sb, c.trip.id);
    if (!plan || plan.latestVersion === 0) return err("not_found");
    if (baseVersion !== plan.latestVersion) return err("conflict");
    const base = await getVersion(c.sb, plan.id, baseVersion);
    if (!base) return err("failed");
    if (!computeCanIterate(base.plan, c.trip, true, true)) return err("outdated");
    if (fb.data.days.some((d) => d > base.plan.days.length)) return err("invalid", { issues: [{ path: "days", message: "day out of range" }] });

    const blocked = await checkBudget(c, RESERVE_PATCH);
    if (blocked) return blocked;
    if (!(await acquireLock(c.sb, plan.id))) return err("busy");
    locked = true;
    // Re-read under the lock: another request may have added a version since the check above.
    const fresh = await getPlanRow(c.sb, c.trip.id);
    if (!fresh || fresh.latestVersion !== plan.latestVersion) return err("conflict");

    // The stored input of the base version keeps the cache prefix identical and avoids refetching facts.
    const res = await patchPlan({ llm: base.input.llm, plan: base.plan, index: base.input.index, feedback: fb.data }, ai.ctx);
    if (!res.ok) return failed(c, res.error, res.error);
    const patched = applyPatch({ base: base.plan, patch: res.data, stored: base.input, scope: fb.data.days });
    if (!patched.ok) return failed(c, patched.reason, "invalid_output");
    const parsed = Plan.safeParse(patched.plan);
    if (!parsed.success) return failed(c, "schema", "invalid_output");

    if (patched.changedDays.length === 0) {
      await logEvent({ event: "plan.patched", userId: c.session.userId, props: { tripId: c.trip.id, changedDays: 0, costMicroUsd: ai.cost() } });
      return await done(c, { unchanged: true, reply: res.data.reply });
    }
    const no = await insertVersion(c.sb, plan.id, {
      kind: "patch",
      plan: parsed.data,
      input: base.input,
      inputHash: base.inputHash,
      feedback: fb.data,
      changedDays: patched.changedDays,
      model: MODEL_PLAN,
      costMicroUsd: ai.cost(),
    });
    await pruneVersions(c.sb, plan.id, no);
    await logEvent({
      event: "plan.patched",
      userId: c.session.userId,
      props: { tripId: c.trip.id, changedDays: patched.changedDays.length, durationMs: Date.now() - started, costMicroUsd: ai.cost(), ...patched.issues },
    });
    return await done(c, { reply: res.data.reply });
  } catch {
    return failed(c, "exception", "failed");
  } finally {
    if (locked && plan) await releaseLock(c.sb, plan.id);
  }
}

/** Resolves plan + latest version for code-only changes. */
async function latestForChange(c: PlanContext, baseVersion: number): Promise<{ plan: PlanRow; base: StoredVersion } | PipelineError> {
  const plan = await getPlanRow(c.sb, c.trip.id);
  if (!plan || plan.latestVersion === 0) return err("not_found");
  if (isBusy(plan)) return err("busy");
  if (baseVersion !== plan.latestVersion) return err("conflict");
  const base = await getVersion(c.sb, plan.id, baseVersion);
  return base ? { plan, base } : err("failed");
}

/** Code-only edit (swap days, best day): no LLM, no budget. */
export async function editPlanVersion(tripId: string, baseVersion: number, edit: unknown): Promise<PipelineResult> {
  const parsed = PlanEdit.safeParse(edit);
  const loaded = await loadPlanContext(tripId);
  if (!loaded.ok) return loaded;
  const c = loaded.ctx;
  if (!parsed.success || !z.number().int().min(1).safeParse(baseVersion).success) return err("invalid");
  try {
    const cur = await latestForChange(c, baseVersion);
    if ("ok" in cur) return cur;
    const n = cur.base.plan.days.length;
    const e = parsed.data;
    const inRange = e.kind === "swap_days" ? e.a <= n && e.b <= n && e.a !== e.b : e.n === null || e.n <= n;
    if (!inRange) return err("invalid");
    const out = applyEdit(cur.base.plan, e);
    const plan = Plan.safeParse(out.plan);
    if (!plan.success) return err("failed");
    if (out.changedDays.length === 0) return await done(c, { unchanged: true });
    const no = await insertVersion(c.sb, cur.plan.id, {
      kind: "edit",
      plan: plan.data,
      input: cur.base.input,
      inputHash: cur.base.inputHash,
      feedback: e,
      changedDays: out.changedDays,
    });
    await pruneVersions(c.sb, cur.plan.id, no);
    return await done(c);
  } catch {
    return err("failed");
  }
}

/** Restores an older version as a new version (copies plan + input). No LLM, no budget. */
export async function restoreVersion(tripId: string, versionNo: number): Promise<PipelineResult> {
  const loaded = await loadPlanContext(tripId);
  if (!loaded.ok) return loaded;
  const c = loaded.ctx;
  if (!z.number().int().min(1).safeParse(versionNo).success) return err("invalid");
  try {
    const row = await getPlanRow(c.sb, c.trip.id);
    if (!row || row.latestVersion === 0) return err("not_found");
    if (isBusy(row)) return err("busy");
    if (versionNo === row.latestVersion) return await done(c, { unchanged: true });
    const [src, latest] = await Promise.all([getVersion(c.sb, row.id, versionNo), getVersion(c.sb, row.id, row.latestVersion)]);
    if (!src) return err("not_found");
    const no = await insertVersion(c.sb, row.id, {
      kind: "restore",
      plan: src.plan,
      input: src.input,
      inputHash: src.inputHash,
      restoredFrom: versionNo,
      changedDays: latest ? diffDays(latest.plan, src.plan) : [],
      model: src.meta.model,
    });
    await pruneVersions(c.sb, row.id, no);
    return await done(c);
  } catch {
    return err("failed");
  }
}

