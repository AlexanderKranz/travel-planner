import "server-only";
import { berlinToday } from "@/lib/date";
import type { FactsCtx } from "@/lib/domain/facts";
import { RetrySpec, type RetryJob } from "@/lib/places-retry";
import { logEvent } from "./events";
import type { ActivityType } from "@/lib/facts/activity-types";
import { getActivityGroupFacts, getCafeFacts, getRestaurantFacts, type ActivityGroupFacts, type LookupFact } from "./facts/activities";
import type { GeoDestination } from "./facts/common";
import { retryInterestLookup } from "./facts/places";
import { createSupabaseAdminClient } from "./supabase/admin";

/** Total time one worker run may spend (the route allows 300 s), spec activities addendum 2, R6. */
export const RUN_BUDGET_MS = 240_000;
/** A job only starts with at least this much left (one Overpass query takes 25-60 s). */
export const MIN_JOB_START_MS = 45_000;
/** Longest a single job may take. */
export const JOB_MAX_MS = 120_000;
/** Extra time on top of a job's budget before it is cut off. */
export const JOB_GRACE_MS = 5_000;
/** Jobs taken per run, oldest first. */
export const CLAIM_BATCH = 5;
/** Lease on claimed jobs: longer than a run, so a slow run is never doubled by the next cron tick. */
export const LEASE_SECONDS = 360;

const ENQUEUE_CHUNK = 20;

/**
 * Records lookups that failed so the worker keeps trying for at most 30 minutes. A key that is already queued is
 * ignored by the database (no new window). Best effort: never throws, never blocks the request for long.
 * Uses the secret key on purpose: the table has no policies and holds no user content.
 */
export async function enqueuePlaceRetries(jobs: RetryJob[]): Promise<void> {
  if (jobs.length === 0) return;
  try {
    const admin = createSupabaseAdminClient();
    // The function takes at most 20 jobs per call; a trip with stops can have more.
    for (let i = 0; i < jobs.length; i += ENQUEUE_CHUNK) {
      const { error } = await admin.rpc("place_retry_enqueue", { p_jobs: jobs.slice(i, i + ENQUEUE_CHUNK) });
      if (error) console.error("place_retry_enqueue failed", error.code);
    }
  } catch (error) {
    console.error("place_retry_enqueue failed", error instanceof Error ? error.name : "unknown");
  }
}

export type JobRow = { id: string; kind: string; params: unknown; attempts: number; created_at: string; give_up_at: string };
export type JobOutcome = "done" | "failed";

/**
 * A group retry is done when it is ok/empty and no WANTED type failed or was skipped. A failed part that holds only
 * unwished types (`partial`) must not keep a job alive. No wanted types (group-only wish) = all types count.
 */
export function groupDone(f: LookupFact<ActivityGroupFacts>, wanted: readonly ActivityType[]): boolean {
  if (f.status !== "ok" && f.status !== "empty") return false;
  const counted = wanted.length ? wanted : (Object.keys(f.data.typeStatus) as ActivityType[]);
  return !counted.some((t) => f.data.typeStatus[t] === "error" || f.data.typeStatus[t] === "skipped");
}

const isDone = (f: { status: string }) => f.status === "ok" || f.status === "empty";

/** Reruns one lookup with the normal cache and fetch rules. `ok` and `empty` count as done (the result is cached). */
export async function runLookup(spec: RetrySpec, budgetMs: number, ctx: FactsCtx): Promise<JobOutcome> {
  // The lookups only read lat, lon and kind of the destination.
  const asDest = (d: { lat: number; lon: number; kind: "city" | "region" }) => d as unknown as GeoDestination;
  switch (spec.kind) {
    case "interest":
      return (await retryInterestLookup(spec.interest as Parameters<typeof retryInterestLookup>[0], spec, spec.radiusKm, ctx, budgetMs)) === "ok" ? "done" : "failed";
    case "activity_group": {
      const f = await getActivityGroupFacts(spec.group, asDest(spec.dest), ctx, { budgetMs, ...(spec.wanted.length ? { wanted: spec.wanted } : {}) });
      return groupDone(f, spec.wanted) ? "done" : "failed";
    }
    case "restaurants": {
      const f = await getRestaurantFacts(asDest(spec.dest), ctx, { budgetMs, ...(spec.near ? { near: spec.near } : {}) });
      return isDone(f) ? "done" : "failed";
    }
    case "cafes": {
      const f = await getCafeFacts(asDest(spec.dest), ctx, { budgetMs, ...(spec.near ? { near: spec.near } : {}) });
      return isDone(f) ? "done" : "failed";
    }
  }
}

export type JobResult = { id: string; kind: string; attempts: number; ageMin: number; result: "done" | "failed" | "gave_up" | "skipped"; error?: string };

/**
 * Runs claimed jobs one after the other (one Overpass slot) inside the run budget. Pure of I/O except `run`:
 * a job past its give_up_at is not run; a job only starts with MIN_JOB_START_MS left; a failed attempt after the
 * window closed is final (`gave_up`). Jobs that did not start are `skipped` (their lease is released by the caller).
 */
export async function processJobs(
  jobs: readonly JobRow[],
  run: (spec: RetrySpec, budgetMs: number) => Promise<JobOutcome>,
  opts: { startedAt: number; budgetMs?: number; now?: () => number },
): Promise<JobResult[]> {
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? RUN_BUDGET_MS;
  const out: JobResult[] = [];
  for (const j of jobs) {
    const base = { id: j.id, kind: j.kind, attempts: j.attempts, ageMin: Math.max(0, Math.round((now() - Date.parse(j.created_at)) / 60_000)) };
    if (now() >= Date.parse(j.give_up_at)) {
      out.push({ ...base, result: "gave_up" });
      continue;
    }
    const left = opts.startedAt + budget - now();
    const spec = RetrySpec.safeParse(j.params);
    if (!spec.success) {
      out.push({ ...base, attempts: j.attempts + 1, result: "gave_up", error: "bad_params" });
      continue;
    }
    if (left < MIN_JOB_START_MS) {
      out.push({ ...base, result: "skipped" });
      continue;
    }
    let outcome: JobOutcome;
    let error: string | undefined;
    try {
      const jobBudget = Math.min(JOB_MAX_MS, left - 5_000);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Hard stop: a lookup that ignores its budget must not eat the whole run.
        outcome = await Promise.race([
          run(spec.data, jobBudget),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("job_timeout")), jobBudget + JOB_GRACE_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      outcome = "failed";
      error = e instanceof Error ? (e.message === "job_timeout" ? "job_timeout" : e.name.slice(0, 60)) : "unknown";
    }
    const attempts = j.attempts + 1;
    if (outcome === "done") out.push({ ...base, attempts, result: "done" });
    else if (now() >= Date.parse(j.give_up_at)) out.push({ ...base, attempts, result: "gave_up", ...(error ? { error } : {}) });
    else out.push({ ...base, attempts, result: "failed", error: error ?? "lookup_failed" });
  }
  return out;
}

export type RunSummary = { expired: number; claimed: number; done: number; failed: number; gaveUp: number };

/** One cron run: expire, claim, run, record. Never throws on a single job. */
export async function runPlaceRetries(): Promise<RunSummary> {
  const startedAt = Date.now();
  // Secret key: the table has no policies; this is the server-only worker (see enqueuePlaceRetries).
  const admin = createSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  const summary: RunSummary = { expired: 0, claimed: 0, done: 0, failed: 0, gaveUp: 0 };

  const { data: expired } = await admin
    .from("place_retry_jobs")
    .update({ status: "gave_up", lease_until: null })
    .eq("status", "queued")
    .lte("give_up_at", nowIso)
    .select("kind, attempts");
  for (const e of expired ?? []) {
    summary.expired += 1;
    await logEvent({ event: "places.retry_gave_up", level: "warn", route: "cron:place-retries", props: { kind: e.kind, attempts: e.attempts, reason: "window" } });
  }

  const { data: claimed, error } = await admin.rpc("place_retry_claim", { p_limit: CLAIM_BATCH, p_lease_seconds: LEASE_SECONDS });
  if (error) throw new Error("claim_failed");
  const jobs = (claimed ?? []) as JobRow[];
  summary.claimed = jobs.length;
  if (jobs.length === 0) return summary;

  const ctx: FactsCtx = { userId: null, locale: "de", today: berlinToday() };
  const results = await processJobs(jobs, (spec, budgetMs) => runLookup(spec, budgetMs, ctx), { startedAt });
  for (const r of results) {
    if (r.result === "skipped") {
      await admin.from("place_retry_jobs").update({ lease_until: null }).eq("id", r.id).eq("status", "queued");
      continue;
    }
    const patch =
      r.result === "done"
        ? { status: "done", attempts: r.attempts, last_error: null, lease_until: null }
        : r.result === "gave_up"
          ? { status: "gave_up", attempts: r.attempts, last_error: r.error ?? null, lease_until: null }
          : { attempts: r.attempts, last_error: r.error ?? null, lease_until: null };
    await admin.from("place_retry_jobs").update(patch).eq("id", r.id).eq("status", "queued");
    if (r.result === "done") {
      summary.done += 1;
      await logEvent({ event: "places.retry_done", route: "cron:place-retries", props: { kind: r.kind, attempts: r.attempts, ageMin: r.ageMin } });
    } else if (r.result === "gave_up") {
      summary.gaveUp += 1;
      await logEvent({ event: "places.retry_gave_up", level: "warn", route: "cron:place-retries", props: { kind: r.kind, attempts: r.attempts, reason: r.error ?? "window" } });
    } else {
      summary.failed += 1;
    }
  }
  return summary;
}

/** Admin Health: place retry jobs, queued now and finished in the last 24 h. Counts only. */
export async function getPlaceRetryStats(): Promise<{ queued: number; done: number; gaveUp: number }> {
  const admin = createSupabaseAdminClient();
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const count = async (status: string, recent: boolean) => {
    let q = admin.from("place_retry_jobs").select("id", { count: "exact", head: true }).eq("status", status);
    if (recent) q = q.gte("updated_at", since);
    // A query error must hide the Health tile (the caller catches), not show a misleading 0.
    const { count: n, error } = await q;
    if (error) throw error;
    return n ?? 0;
  };
  const [queued, done, gaveUp] = await Promise.all([count("queued", false), count("done", true), count("gave_up", true)]);
  return { queued, done, gaveUp };
}
