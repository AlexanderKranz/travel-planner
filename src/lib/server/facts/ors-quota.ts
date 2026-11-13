import "server-only";
import { QuotaGuardError } from "../flights-quota";
import { createSupabaseAdminClient } from "../supabase/admin";
import { getEffectiveEnv } from "../settings";

/**
 * ORS counts matrix and Directions requests separately (500 and 2000 per 24 h on the free Standard plan, each shared
 * by all profiles; headers checked live 2026-11-12, spec city-tour section 14). The app keeps one bucket per ORS
 * endpoint, a margin below each limit, so tours, plans and drive searches cannot use up each other's endpoint.
 *
 * - matrix bucket: plan drive times (`matrix`) and tour orders (`tour_matrix`)
 * - directions bucket: drive-search routes (`route`), tour legs (`tour_route`) and tour directions (`tour_steps`)
 */
export type OrsBucket = "matrix" | "directions";

/** `api_calls.endpoint` values (provider `openrouteservice`) per bucket. */
export const ORS_BUCKET_ENDPOINTS: Record<OrsBucket, readonly string[]> = {
  matrix: ["matrix", "tour_matrix"],
  directions: ["route", "tour_route", "tour_steps"],
};

export const ORS_MATRIX_DAILY_DEFAULT = 450;
export const ORS_DIRECTIONS_DAILY_DEFAULT = 1800;
/** Matrix requests kept for plans (their drive times are a matrix call): tours never use the last 50. */
export const ORS_PLAN_RESERVE = 50;
/**
 * ORS's window is a fixed 24 h opened by the first request after the last one ended, not a calendar day. Counting the
 * last 24 h at or under the cap keeps every ORS window under it too; a Berlin-day count could let two app days fall
 * into one ORS window.
 */
export const ORS_WINDOW_MS = 24 * 3_600_000;

type Env = Record<string, string | undefined>;

function intEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Caps per bucket from `ORS_MATRIX_DAILY` and `ORS_DIRECTIONS_DAILY` (admin settings overlay the env). */
export function orsCaps(env: Env = process.env): Record<OrsBucket, number> {
  return {
    matrix: intEnv(env.ORS_MATRIX_DAILY, ORS_MATRIX_DAILY_DEFAULT),
    directions: intEnv(env.ORS_DIRECTIONS_DAILY, ORS_DIRECTIONS_DAILY_DEFAULT),
  };
}

/**
 * Network requests per bucket in the last 24 h, from `api_calls` (cache hits excluded, and rows the app's own guard
 * refused, which never reached ORS: with a rolling window they would otherwise keep the bucket closed for as long as
 * refused attempts keep coming). SECRET KEY (RLS bypass) on purpose: `api_calls` has no user grants and these are
 * aggregate counts. Throws QuotaGuardError when a count cannot be read (callers fail closed).
 */
export async function orsUsage24h(now: Date = new Date()): Promise<Record<OrsBucket, number>> {
  const since = new Date(now.getTime() - ORS_WINDOW_MS).toISOString();
  try {
    const admin = createSupabaseAdminClient();
    const count = async (bucket: OrsBucket) => {
      const { count: n, error } = await admin
        .from("api_calls")
        .select("id", { count: "exact", head: true })
        .eq("provider", "openrouteservice")
        .in("endpoint", [...ORS_BUCKET_ENDPOINTS[bucket]])
        .neq("cache", "hit")
        .or("error_code.is.null,error_code.neq.quota_guard")
        .gte("created_at", since);
      if (error) throw new Error("quota read failed");
      return n ?? 0;
    };
    const [matrix, directions] = await Promise.all([count("matrix"), count("directions")]);
    return { matrix, directions };
  } catch {
    throw new QuotaGuardError("ORS quota state unavailable");
  }
}

/** Requests left per bucket; both 0 when the count cannot be read (fails closed). */
export async function orsLeft(now: Date = new Date()): Promise<Record<OrsBucket, number>> {
  try {
    const caps = orsCaps(await getEffectiveEnv());
    const used = await orsUsage24h(now);
    return { matrix: Math.max(0, caps.matrix - used.matrix), directions: Math.max(0, caps.directions - used.directions) };
  } catch {
    return { matrix: 0, directions: 0 };
  }
}

/** Requests left in one bucket over the last 24 h; 0 when the count cannot be read. */
export async function orsRequestsLeft(bucket: OrsBucket): Promise<number> {
  return (await orsLeft())[bucket];
}

/** Throws QuotaGuardError when the bucket's last-24-h requests reached its cap. Fails closed. Runs before each call. */
export async function assertOrsQuota(bucket: OrsBucket): Promise<void> {
  if ((await orsRequestsLeft(bucket)) < 1) throw new QuotaGuardError(`ORS ${bucket} cap reached`);
}

/**
 * Tour gate (spec city-tour 11 step 4, section 14): one matrix request above the plan reserve (skipped with "keep
 * my order") and one Directions request per run of legs.
 */
export function tourGateOk(left: Record<OrsBucket, number>, runs: number, needsMatrix = true): boolean {
  return (!needsMatrix || left.matrix >= 1 + ORS_PLAN_RESERVE) && left.directions >= runs;
}

export async function orsTourGate(runs: number, opts: { needsMatrix?: boolean } = {}): Promise<boolean> {
  return tourGateOk(await orsLeft(), runs, opts.needsMatrix ?? true);
}
