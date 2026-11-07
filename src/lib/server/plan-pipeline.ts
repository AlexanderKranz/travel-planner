import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { berlinToday } from "@/lib/date";
import { MODEL_PLAN, type AiCtx } from "@/lib/domain/ai";
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
import { canEdit, type Access } from "@/lib/domain/sharing";
import type { Trip } from "@/lib/domain/trip";
import { applyEdit } from "@/lib/plan/edit";
import { canonicalJson, planInputHash } from "@/lib/plan/hash";
import type { AgeRefs } from "@/lib/group";
import { tripGroupSource } from "@/lib/group-text";
import { tripPurpose } from "@/lib/purpose-source";
import { buildPlanInput, type GroupContext } from "@/lib/plan/input";
import { allPlacesPending, activityPlacesPending, blockingScope } from "@/lib/plan/places-pending";
import { drivePicks } from "@/lib/plan/drive-picks";
import { extendInput, resolveNeedPlaces, type NeedPlacesRequest } from "@/lib/plan/need-places";
import { loadActivityLookups, type ActivityLookupRequest } from "./facts/activity-lookups";
import { geoDestination } from "./facts/common";
import { scheduleActivityWarm } from "./warm";
import { jobsForActivityLookups, jobsForTripFacts } from "@/lib/places-retry";
import { enqueuePlaceRetries } from "./place-retries";
import { PLACES_CACHE_ONLY } from "./facts/places";
import { applyPatch } from "@/lib/plan/patch";
import { guardPatch } from "@/lib/plan/patch-guard";
import { assemblePlan } from "@/lib/plan/assemble";
import { fixedItemsOf, fixedSlots } from "@/lib/plan/fixed-items";
import type { TripItem } from "@/lib/domain/items";
import { ITEM_COLUMNS, rowToItem, type ItemRow } from "./item-mapping";
import { composePlan, patchPlan } from "./ai/compose";
import { berlinMidnight, budgetAllows, getBudgetStatus, isAiEnabled, logAiUsage, userCapMicroUsd, type BudgetInfo, type Role } from "./ai-usage";
import { logEvent } from "./events";
import { getTripFacts } from "./facts";
import { getDriveTimes } from "./facts/drive-times";
import { getGroup } from "./groups";
import {
  acquireLock,
  ensurePlan,
  findVersionByHash,
  getPlanRow,
  getVersion,
  getVersionLight,
  insertVersion,
  isBusy,
  hasBusyPlan,
  listVersionMetas,
  pruneVersions,
  releaseLock,
  type PlanRow,
  type StoredVersion,
} from "./plan-store";
import { loadAgeRefs } from "./age-refs";
import { loadOwnerContext } from "./owner-context";
import { getProfile } from "./profile";
import { tagAndSave, wantsTags } from "./purpose-tagging";
import { getPurpose } from "./purposes";
import { tagTripPurpose, wantsTripTags } from "./trip-purpose-text";
import { rateLimit } from "./rate-limit";
import { getUserSession } from "./session";
import { getTrip } from "./trips";
import { getEffectiveEnv } from "./settings";

/**
 * The server loads places itself before composing (one request does everything, so leaving the page cannot stop
 * a run): up to 110 s of network queries (Geoapify has a 25 s client timeout; Overpass queries are cut at the
 * deadline) + ~10 s drive times + 140 s Sonnet stays inside the route's 300 s. Cached interests are served
 * instantly, whatever the budget. Interests that did not load in time make the run answer `places_pending`
 * (retry or "generate anyway") exactly as before.
 */
export const PLACES_BUDGET_MS = 110_000;
/** Seconds the client should wait before retrying when places are still loading. */
export const PLACES_RETRY_AFTER_S = 60;
const RESERVE_TAGS = 2_000;
const RESERVE_GENERATE = 150_000;
const RESERVE_PATCH = 50_000;
const Id = z.string().uuid();

/** `rejectedDays`: patched days the shrink guard reverted (patch-safety [D3]); the client explains them. */
/** `notice`: a fixed client message instead of the model reply (`places_not_loadable`: plan.iterate.placesNotLoadable). */
export type PipelineData = { state: PlanState; unchanged?: true; reply?: string; rejectedDays?: number[]; notice?: "places_not_loadable" };
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
  /** Role and demo flag of the ACTING user: budget, rate limits and ai_usage are theirs (spec sharing 1.1). */
  role: Role;
  isDemo: boolean;
  /** The viewer's access to the trip (owner, write or read). */
  access: Access;
  /** Owner of the trip and its plan. */
  ownerId: string;
  /**
   * Birthdate and home airports of the plan OWNER (spec sharing 1.2): for the owner these are their own profile values,
   * for a write grantee the owner's (read on the server, never sent to the client), so the same input gives the same
   * hash and plan whoever starts the run.
   */
  birthdate: string | null;
  /** Anchors for `is_self` and "about my age" (spec group-sharing 1.4); equal to `birthdate` for both when T = G. */
  ageRefs: AgeRefs;
  homeAirports: string[];
  /** Language of a first plan on a shared trip: the owner's locale (null for the owner: their request locale counts). */
  ownerLocale: Locale | null;
  trip: Trip;
  group: GroupContext | null;
  purpose: TripPurpose | null;
};

const err = (error: ActionError, extra: Partial<PipelineError> = {}): PipelineError => ({ ok: false, error, ...extra });

/** The four reads that build a PlanContext. Write paths use the direct ones; the trip page passes request-cached ones. */
export type ContextReaders = {
  getProfile: typeof getProfile;
  getTrip: typeof getTrip;
  getGroup: typeof getGroup;
  getPurpose: typeof getPurpose;
};
const DIRECT_READERS: ContextReaders = { getProfile, getTrip, getGroup, getPurpose };

/** Session, profile, trip (RLS), group, purpose. */
export async function loadPlanContext(
  tripId: string,
  readers: ContextReaders = DIRECT_READERS,
): Promise<{ ok: true; ctx: PlanContext } | PipelineError> {
  const session = await getUserSession();
  if (!session) return err("unauthenticated");
  if (!Id.safeParse(tripId).success) return err("not_found");
  const [profile, tripRes] = await Promise.all([readers.getProfile(), readers.getTrip(tripId)]);
  if (!tripRes.ok) return err(tripRes.error === "not_found" || tripRes.error === "invalid" ? "not_found" : "failed");
  if (!profile.ok) return err("failed");
  const trip = tripRes.data;
  let group: GroupContext | null = null;
  let purpose: TripPurpose | null = null;
  // Group and purpose do not depend on each other.
  const [g, p] = await Promise.all([
    trip.groupId ? readers.getGroup(trip.groupId) : null,
    trip.purposeId ? readers.getPurpose(trip.purposeId) : null,
  ]);
  if (trip.groupId) {
    if (g?.ok) group = g.data;
  } else {
    // One-off group of the trip: free text, corrected structure and Haiku parse live on the trip itself.
    const src = tripGroupSource(trip);
    if (src) group = { ...src, updatedAt: trip.updatedAt };
  }
  // The saved purpose, else the trip's one-off text (spec trip-purpose-text P5).
  purpose = tripPurpose(trip, p?.ok ? p.data : null);
  // A non-owner (write or read grantee): the plan belongs to the owner, so the pipeline uses the OWNER's birthdate, home
  // airports and locale. Read here, after the trip was visible through RLS, with the secret key (owner-context.ts).
  let birthdate = profile.data.birthdate;
  let homeAirports = profile.data.homeAirports;
  let ownerLocale: Locale | null = null;
  if (trip.access !== "owner") {
    const owner = await loadOwnerContext(trip.ownerId);
    if (!owner) return err("failed"); // fail closed: never fall back to the grantee's own values
    birthdate = owner.birthdate;
    homeAirports = owner.homeAirports;
    ownerLocale = owner.locale;
  }
  // Who `is_self` and "about my age" refer to (docs/specs/group-sharing.md 1.4). They depend on the TRIP owner T and the
  // GROUP owner G, never on the viewer or the actor. T = G (every existing trip, the one-off group): T's birthdate for
  // both. G != T: G's profile birthdate, read with the secret key after the group was read through RLS (3.3); it fails
  // closed, like the trip owner's.
  const refs = await loadAgeRefs({ tripOwnerId: trip.ownerId, tripOwnerBirthdate: birthdate, group });
  if (!refs) return err("failed");
  return {
    ok: true,
    ctx: {
      session,
      sb: session.supabase as SupabaseClient,
      role: profile.data.role,
      isDemo: profile.data.isDemo,
      access: trip.access,
      ownerId: trip.ownerId,
      birthdate,
      ageRefs: refs,
      homeAirports,
      ownerLocale,
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
    const cap = userCapMicroUsd(c.role, c.isDemo, await getEffectiveEnv());
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
    // The settings read is independent of the plan row: one round for both.
    const [row, env] = await Promise.all([getPlanRow(c.sb, c.trip.id), getEffectiveEnv()]);
    const aiEnabled = isAiEnabled(env);
    const busy = isBusy(row);
    // Everything below needs only the row (and the session): one parallel round. The requested (or latest-by-row)
    // version is fetched speculatively; a failure or a different newest version falls back to a normal read below.
    const guess = row && row.latestVersion > 0 ? (requested ?? row.latestVersion) : requested;
    const speculative = row && guess !== undefined ? getVersionLight(c.sb, row.id, guess).catch(() => undefined) : undefined;
    // While busy the client only polls for completion: skip the two admin aggregate queries (budget is static then).
    const [versions, info] = await Promise.all([
      row ? listVersionMetas(c.sb, row.id) : [],
      busy
        ? { spentMicroUsd: 0, capMicroUsd: userCapMicroUsd(c.role, c.isDemo, env), resetsAt: berlinMidnight(new Date(), 1).toISOString(), globalSpentMicroUsd: 0, globalCapMicroUsd: 1 }
        : budgetInfo(c),
    ]);
    const exhausted = info.globalSpentMicroUsd >= info.globalCapMicroUsd;
    const budget = {
      spentMicroUsd: exhausted ? info.capMicroUsd : info.spentMicroUsd,
      capMicroUsd: info.capMicroUsd,
      resetsAt: info.resetsAt,
    };
    const base = { tripId: c.trip.id, versions, busy, aiEnabled, budget, access: c.access };
    if (!row || versions.length === 0) {
      if (requested !== undefined) return err("not_found");
      return { ok: true, state: { ...base, version: null, isLatest: true, outdated: false, canIterate: false } };
    }
    const wanted = requested ?? versions[0].versionNo;
    const meta = versions.find((m) => m.versionNo === wanted);
    if (!meta) return err("not_found");
    const stored = (wanted === guess ? await speculative : undefined) ?? (await getVersionLight(c.sb, row.id, wanted));
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
        ...(isLatest && stored.pendingPlaces.length > 0 ? { placesIncomplete: true } : {}),
        ...(isLatest && !stored.hasRestaurants ? { predatesSuggestions: true } : {}),
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
async function gate(userId: string): Promise<PipelineError | null> {
  const rl = rateLimit(`plan:${userId}`, 2, 60_000);
  if (!rl.ok) return err("rate_limited", { retryAfter: rl.retryAfterSeconds });
  if (!isAiEnabled(await getEffectiveEnv())) return err("ai_disabled");
  return null;
}

/** Trip items with the user session (RLS). Throws on read errors (the callers map them to `failed`). */
export async function loadTripItems(sb: SupabaseClient, tripId: string): Promise<TripItem[]> {
  const { data, error } = await sb.from("trip_items").select(ITEM_COLUMNS).eq("trip_id", tripId).returns<ItemRow[]>();
  if (error) throw new Error("items read failed");
  return data.map(rowToItem);
}

/**
 * Language of a plan on a shared trip: the latest version's, else the owner's locale. The request locale of a write
 * grantee never decides, so the plan does not switch language behind the owner's back.
 */
async function sharedPlanLocale(c: PlanContext, plan: PlanRow): Promise<Locale> {
  if (plan.latestVersion > 0) {
    const latest = await getVersionLight(c.sb, plan.id, plan.latestVersion);
    if (latest) return latest.plan.locale as Locale;
  }
  return c.ownerLocale ?? "de";
}

/**
 * One call does everything (places, facts, compose), so the browser may leave at any time.
 * `force`: "generate anyway": skip the places step (cache only) and generate even when places are missing.
 * `fresh`: always call the model, even when the input equals an earlier version (the user's "Regenerate plan").
 *
 * `clientGone`: evaluated only when places turn out pending. True = nobody is left to see the retry prompt, so the
 * run generates with what is cached (like `force`). If the signal behind it is unreliable it stays false and the
 * run returns `places_pending` as before.
 *
 * Lock: the generation lock is taken right after the cheap guards (before Haiku tags and places), so a run is
 * visible as busy from its first second and a second request returns `busy` instead of spending budget twice.
 * It is released in `finally` on every exit. A crashed run cannot block the trip: the lock expires after LOCK_MS.
 */
export async function generatePlan(
  tripId: string,
  requestLocale: Locale,
  opts: { force?: boolean; fresh?: boolean; clientGone?: () => boolean } = {},
): Promise<PipelineResult> {
  const loaded = await loadPlanContext(tripId);
  if (!loaded.ok) return loaded;
  let c = loaded.ctx;
  if (!canEdit(c.access)) return err("forbidden");
  let locale: Locale = requestLocale;
  const g = await gate(c.session.userId);
  if (g) return g;
  if (c.trip.lengthDays > MAX_PLAN_DAYS) return err("too_long");

  const started = Date.now();
  const ai = makeAiCtx(c);
  let plan: PlanRow | null = null;
  let lock: string | null = null;
  try {
    // Per-user in-flight guard: parallel requests could otherwise all pass the budget check (spend is recorded late).
    if (await hasBusyPlan(c.sb, c.session.userId)) return err("busy");
    // Lock first (creates the plan row for a trip without one). The budget check below returns through `finally`.
    plan = await ensurePlan(c.sb, c.trip.id);
    lock = await acquireLock(c.sb, plan.id);
    if (!lock) return err("busy");
    // A run that finished between ensurePlan and the lock may have added a version: read latestVersion under the lock.
    plan = (await getPlanRow(c.sb, c.trip.id)) ?? plan;
    // On a shared trip the plan keeps its language: the latest version's, else the owner's (spec sharing 1.2).
    if (c.access !== "owner") locale = await sharedPlanLocale(c, plan);
    // 3. Haiku tags (once per purpose content, cached in parsed_*)
    let purpose = c.purpose;
    if (wantsTripTags(purpose)) {
      // The trip's one-off purpose text (trip-purpose-text P4): tags are saved on the trip row, which moves its
      // updated_at. Continue with the new value for trip, one-off group and purpose so the plan basis stays current.
      const blocked = await checkBudget(c, RESERVE_TAGS);
      if (blocked) return blocked;
      const tagged = await tagTripPurpose({ userId: c.session.userId, sb: c.sb }, c.trip, purpose, ai.ctx);
      purpose = tagged.purpose;
      if (tagged.updatedAt) {
        const updatedAt = tagged.updatedAt;
        c = {
          ...c,
          trip: { ...c.trip, updatedAt },
          group: c.group && !c.trip.groupId ? { ...c.group, updatedAt } : c.group,
        };
      }
    } else if (wantsTags(purpose)) {
      const blocked = await checkBudget(c, RESERVE_TAGS);
      if (blocked) return blocked;
      purpose = await tagAndSave(c.session.userId, purpose, ai.ctx);
    }

    // 4. facts + input
    const facts = await getTripFacts(
      c.trip,
      purpose,
      { userId: c.session.userId, locale, today: berlinToday() },
      {
        // `force` is "generate anyway": the user chose not to wait, so only cached places are read.
        placesBudgetMs: opts.force ? PLACES_CACHE_ONLY : PLACES_BUDGET_MS,
        withFlights: c.trip.wantsFlights ? { homeAirports: c.homeAirports } : undefined,
      },
    );
    // Only named activity types (and group-only wishes) can block (QA #139); an open wish's extra types are best effort.
    const scope = blockingScope(purpose?.tags?.activities ?? []);
    const pending = allPlacesPending(facts, scope);
    // Keep trying in the background (at most 30 min per search), also for "generate anyway" and regenerate.
    await enqueuePlaceRetries(jobsForTripFacts(c.trip, purpose, facts, scope));
    // `fresh` (regenerate) never blocks on places: an earlier version exists and the user wants a new one.
    if (pending && !opts.force && !opts.fresh) {
      const gone = opts.clientGone?.() === true;
      await logEvent({
        event: gone ? "plan.places_pending_generated" : "plan.places_pending",
        level: "warn",
        userId: c.session.userId,
        props: { tripId: c.trip.id, interests: pending.join(","), clientGone: gone },
      });
      if (!gone) return err("places_pending", { retryAfter: PLACES_RETRY_AFTER_S });
    }
    // Drive times from the destination point to every place that goes into the input (one ORS matrix call).
    const dest = c.trip.destination;
    const drivePlaces = drivePicks(facts, purpose);
    const drive =
      drivePlaces.length && dest.kind !== "freetext"
        ? await getDriveTimes({ lat: dest.lat, lon: dest.lon }, drivePlaces, { userId: c.session.userId, locale, today: berlinToday() })
        : null;
    const built = buildPlanInput({
      trip: c.trip,
      group: c.group,
      purpose,
      ageRefs: c.ageRefs,
      facts,
      locale,
      today: berlinToday(),
      drive,
      items: await loadTripItems(c.sb, c.trip.id),
    });
    const inputHash = planInputHash(built.stored.llm);

    // 5. dedupe (D13)
    const latest = plan.latestVersion > 0 ? await getVersion(c.sb, plan.id, plan.latestVersion) : null;
    const hit = opts.fresh
      ? null
      : latest?.inputHash === inputHash
        ? latest
        : await findVersionByHash(c.sb, plan.id, inputHash);
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

    // 7. compose (lock already held since the start)
    const res = await composePlan(built.stored.llm, ai.ctx);
    if (!res.ok) return failed(c, res.error, res.error);
    const assembled = assemblePlan({
      llm: res.data,
      stored: built.stored,
      header: { ...built.header, generatedAt: new Date().toISOString(), model: MODEL_PLAN },
      digest: built.digest,
      locale,
      flights: built.flights,
    });
    if (!assembled.ok) return failed(c, assembled.reason, "invalid_output");
    const parsed = Plan.safeParse(assembled.plan);
    if (!parsed.success) return failed(c, "schema", "invalid_output");

    const no = await insertVersion(c.sb, plan.id, {
      kind: "generate",
      plan: parsed.data,
      // `pendingPlaces` sits beside llm/index: the hash is computed from `llm` only.
      input: pending ? { ...built.stored, pendingPlaces: pending } : built.stored,
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
    if (lock && plan) await releaseLock(c.sb, plan.id, lock);
  }
}

/**
 * Shared deadline of one iterate request (activities spec section 4): route maxDuration 300 s, plan lock 5 min.
 * Places get min(60 s, remaining - 160 s); the second patch call needs >= 120 s and gets the remaining time - 10 s.
 */
export const ITERATE_DEADLINE_MS = 270_000;
export const NEED_PLACES_MAX_MS = 60_000;
const NEED_PLACES_RESERVE_MS = 160_000;
export const SECOND_PATCH_MIN_MS = 120_000;
const SECOND_PATCH_MARGIN_MS = 10_000;
/** after() warming may run until the route's maxDuration (300 s) minus a margin. */
const AFTER_LIMIT_MS = 290_000;

type PatchOk = Extract<Awaited<ReturnType<typeof patchPlan>>, { ok: true }>;

/**
 * needPlaces: load the requested places (cache first), extend the stored input and run the patch once more with
 * FEEDBACK.loaded (no further request). Places that did not load, or too little time left, answer `places_pending`
 * without a new version and keep loading in after(). Budget is checked again (the first call is already logged).
 */
async function patchWithPlaces(
  c: PlanContext,
  a: {
    base: StoredVersion;
    feedback: PlanFeedback;
    fixed: ReturnType<typeof fixedSlots>;
    need: NeedPlacesRequest;
    started: number;
    ai: ReturnType<typeof makeAiCtx>;
  },
): Promise<{ ok: true; res: PatchOk; stored: StoredVersion["input"] } | PipelineError> {
  const { base, need } = a;
  const left = () => a.started + ITERATE_DEADLINE_MS - Date.now();
  const placesBudget = Math.min(NEED_PLACES_MAX_MS, left() - NEED_PLACES_RESERVE_MS);
  const dest = geoDestination(c.trip);
  const req: ActivityLookupRequest = {
    groups: need.groups,
    restaurants: need.restaurants
      ? need.restaurants.near
        ? { near: { lat: need.restaurants.near.lat, lon: need.restaurants.near.lon } }
        : {}
      : false,
    cafes: need.cafes ? (need.cafes.near ? { near: { lat: need.cafes.near.lat, lon: need.cafes.near.lon } } : {}) : false,
    wanted: need.types,
  };
  const factsCtx = { userId: c.session.userId, locale: base.plan.locale as Locale, today: berlinToday() };
  await logEvent({
    event: "plan.patch_need_places",
    userId: c.session.userId,
    props: {
      tripId: c.trip.id,
      types: need.types.join(","),
      restaurants: !!need.restaurants,
      near: !!need.restaurants?.near,
      cafes: !!need.cafes,
      budgetMs: Math.max(0, placesBudget),
    },
  });
  const loaded = await loadActivityLookups(dest, req, factsCtx, Math.max(PLACES_CACHE_ONLY, placesBudget));
  // `error`, and `skipped` for lack of time (cache-only miss): retry after warming. A free-text destination passes.
  const missing = activityPlacesPending(loaded, new Set(need.types));
  const tooLate = left() < SECOND_PATCH_MIN_MS;
  if (missing.length || tooLate) {
    if (missing.length) {
      // After the warm-up below, keep trying in the background (at most 30 min per search).
      await enqueuePlaceRetries(
        jobsForActivityLookups(
          dest && { lat: dest.lat, lon: dest.lon, kind: dest.kind },
          loaded,
          { restaurants: need.restaurants?.near, cafes: need.cafes?.near },
          { types: new Set(need.types) },
        ),
      );
    }
    if (missing.length) scheduleActivityWarm(dest, req, factsCtx, AFTER_LIMIT_MS - (Date.now() - a.started));
    await logEvent({
      event: "plan.places_pending",
      level: "warn",
      userId: c.session.userId,
      props: { tripId: c.trip.id, interests: missing.join(","), patch: true, tooLate, costMicroUsd: a.ai.cost() },
    });
    return err("places_pending", { retryAfter: PLACES_RETRY_AFTER_S });
  }
  const blocked = await checkBudget(c, RESERVE_PATCH);
  if (blocked) return blocked;
  const country = c.trip.destination.kind === "freetext" ? null : c.trip.destination.countryCode;
  const stored = extendInput(base.input, need, loaded, { lang: base.plan.locale as Locale, countryCode: country });
  const res = await patchPlan(
    { llm: stored.llm, plan: base.plan, index: stored.index, feedback: a.feedback, fixed: a.fixed, loaded: true, timeoutMs: left() - SECOND_PATCH_MARGIN_MS },
    a.ai.ctx,
  );
  if (!res.ok) return failed(c, res.error, res.error);
  return { ok: true, res, stored };
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
  if (!canEdit(c.access)) return err("forbidden");
  const fb = PlanFeedback.safeParse(feedback);
  if (!fb.success || !z.number().int().min(1).safeParse(baseVersion).success) {
    return err("invalid", fb.success ? undefined : { issues: fb.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });
  }
  const g = await gate(c.session.userId);
  if (g) return g;
  if (c.trip.lengthDays > MAX_PLAN_DAYS) return err("too_long");

  const started = Date.now();
  const ai = makeAiCtx(c);
  let plan: PlanRow | null = null;
  let lock: string | null = null;
  try {
    if (await hasBusyPlan(c.sb, c.session.userId)) return err("busy");
    plan = await getPlanRow(c.sb, c.trip.id);
    if (!plan || plan.latestVersion === 0) return err("not_found");
    if (baseVersion !== plan.latestVersion) return err("conflict");
    const base = await getVersion(c.sb, plan.id, baseVersion);
    if (!base) return err("failed");
    if (!computeCanIterate(base.plan, c.trip, true, true)) return err("outdated");
    if (fb.data.days.some((d) => d > base.plan.days.length)) return err("invalid", { issues: [{ path: "days", message: "day out of range" }] });

    const blocked = await checkBudget(c, RESERVE_PATCH);
    if (blocked) return blocked;
    lock = await acquireLock(c.sb, plan.id);
    if (!lock) return err("busy");
    // Re-read under the lock: another request may have added a version since the check above.
    const fresh = await getPlanRow(c.sb, c.trip.id);
    if (!fresh || fresh.latestVersion !== plan.latestVersion) return err("conflict");

    // The stored input of the base version keeps the cache prefix identical and avoids refetching facts.
    // Current timed items (may have changed since the base version); sent only when they differ from INPUT.fixed.
    const fixed = fixedSlots(fixedItemsOf(await loadTripItems(c.sb, c.trip.id), base.plan.days.length));
    let res = await patchPlan({ llm: base.input.llm, plan: base.plan, index: base.input.index, feedback: fb.data, fixed }, ai.ctx);
    if (!res.ok) return failed(c, res.error, res.error);
    // Option A (activities spec section 4): the model asked for places the input lacks. Load them, extend the
    // stored input and patch once more; the first answer is discarded.
    let stored = base.input;
    const need = resolveNeedPlaces(res.data.needPlaces, base.input);
    if (need) {
      const second = await patchWithPlaces(c, { base, feedback: fb.data, fixed, need, started, ai });
      if (!second.ok) return second;
      res = second.res;
      stored = second.stored;
    }
    // The model asked for places that cannot be loaded (unknown kinds, or again after loading) and changed nothing:
    // its reply ("I will load them") would be false, so the client shows a fixed message instead.
    if (res.data.needPlacesUnusable && res.data.days.length === 0) {
      await logEvent({
        event: "plan.patched",
        userId: c.session.userId,
        props: { tripId: c.trip.id, changedDays: 0, needPlacesUnusable: true, costMicroUsd: ai.cost() },
      });
      return await done(c, { unchanged: true, notice: "places_not_loadable" });
    }
    const patched = applyPatch({ base: base.plan, patch: res.data, stored, scope: fb.data.days, fixed });
    if (!patched.ok) return failed(c, patched.reason, "invalid_output");
    // Shrink guard: a day that lost most of its activities is kept as it was, never silently accepted.
    const guarded = guardPatch({ base: base.plan, next: patched.plan, feedback: fb.data, index: stored.index });
    const rejectedDays = guarded.rejected.map((r) => r.n);
    if (rejectedDays.length) {
      await logEvent({
        event: "plan.patch_shrink_rejected",
        level: "warn",
        userId: c.session.userId,
        props: {
          tripId: c.trip.id,
          days: rejectedDays.join(","),
          actsBefore: guarded.rejected.reduce((n, r) => n + r.before, 0),
          actsAfter: guarded.rejected.reduce((n, r) => n + r.after, 0),
          costMicroUsd: ai.cost(),
        },
      });
    }
    const parsed = Plan.safeParse(guarded.plan);
    if (!parsed.success) return failed(c, "schema", "invalid_output");
    const extra = rejectedDays.length ? { rejectedDays } : {};

    if (guarded.changedDays.length === 0) {
      await logEvent({ event: "plan.patched", userId: c.session.userId, props: { tripId: c.trip.id, changedDays: 0, costMicroUsd: ai.cost() } });
      // The model's reply describes the rejected change; only the rejection notice is true then.
      return await done(c, rejectedDays.length ? { unchanged: true, ...extra } : { unchanged: true, reply: res.data.reply });
    }
    const no = await insertVersion(c.sb, plan.id, {
      kind: "patch",
      plan: parsed.data,
      // With loaded places the new version keeps the extended input, so later patches see those places.
      input: stored,
      // The base hash like every patch, so a later Generate can never match a patched plan by its input hash.
      inputHash: base.inputHash,
      feedback: fb.data,
      changedDays: guarded.changedDays,
      model: MODEL_PLAN,
      costMicroUsd: ai.cost(),
    });
    await pruneVersions(c.sb, plan.id, no);
    await logEvent({
      event: "plan.patched",
      userId: c.session.userId,
      props: {
        tripId: c.trip.id,
        changedDays: guarded.changedDays.length,
        durationMs: Date.now() - started,
        costMicroUsd: ai.cost(),
        keptNotes: guarded.keptNotes.length,
        needPlaces: need !== null,
        ...patched.issues,
      },
    });
    return await done(c, { reply: res.data.reply, ...extra });
  } catch {
    return failed(c, "exception", "failed");
  } finally {
    if (lock && plan) await releaseLock(c.sb, plan.id, lock);
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

/** Code-only edit (swap days, best day, activity edits): no LLM, no budget. */
export async function editPlanVersion(tripId: string, baseVersion: number, edit: unknown): Promise<PipelineResult> {
  const parsed = PlanEdit.safeParse(edit);
  const loaded = await loadPlanContext(tripId);
  if (!loaded.ok) return loaded;
  const c = loaded.ctx;
  if (!canEdit(c.access)) return err("forbidden");
  if (!parsed.success || !z.number().int().min(1).safeParse(baseVersion).success) return err("invalid");
  // Every edit writes a version: cap bursts (taps on × are cheap), separate from the AI gate.
  const rl = rateLimit(`plan-edit:${c.session.userId}`, 20, 60_000);
  if (!rl.ok) return err("rate_limited", { retryAfter: rl.retryAfterSeconds });
  try {
    const cur = await latestForChange(c, baseVersion);
    if ("ok" in cur) return cur;
    const n = cur.base.plan.days.length;
    const e = parsed.data;
    const inRange =
      e.kind === "swap_days"
        ? e.a <= n && e.b <= n && e.a !== e.b
        : e.kind === "set_best"
          ? e.n === null || e.n <= n
          : "n" in e
            ? e.n <= n
            : true; // the list checks its own bounds
    if (!inRange) return err("invalid");
    const out = applyEdit(cur.base.plan, e);
    const plan = Plan.safeParse(out.plan);
    if (!plan.success) return err("failed");
    if (out.plan === cur.base.plan) return await done(c, { unchanged: true });
    const no = await insertVersion(c.sb, cur.plan.id, {
      kind: "edit",
      plan: plan.data,
      input: cur.base.input,
      inputHash: cur.base.inputHash,
      feedback: e,
      changedDays: out.changedDays,
    });
    await pruneVersions(c.sb, cur.plan.id, no);
    await logEvent({ event: "plan.edited", userId: c.session.userId, props: { tripId: c.trip.id, kind: e.kind, changedDays: out.changedDays.length } });
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
  if (!canEdit(c.access)) return err("forbidden");
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

