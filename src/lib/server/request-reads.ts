import "server-only";
import { cache } from "react";
import type { PlanState } from "@/lib/domain/plan";
import { fail, type ActionResult } from "@/lib/domain/result";
import { getGroup } from "./groups";
import { loadPlanContext, loadPlanState, type ContextReaders } from "./plan-pipeline";
import { getProfile } from "./profile";
import { getPurpose } from "./purposes";
import { getTrip } from "./trips";

/**
 * Request-scoped reads for server components (the trip page and what it renders).
 *
 * React `cache` memoizes per render pass, i.e. per request and therefore per user: nothing is shared between
 * requests or users, and it is gone when the response is done. These wrappers are deliberately NOT in a
 * "use server" file (every export there becomes a callable server action), and the originals stay untouched.
 *
 * Write paths (server actions, route handlers, the plan pipelines) keep calling the uncached readers so they never
 * see a value read before their own write. Only components that render once per request use these.
 * Public share reads (`getSharedPlanDocument`, admin client) have nothing to do with this module.
 */
export const getProfileOnce = cache(() => getProfile());
export const getTripOnce = cache((id: string) => getTrip(id));
export const getGroupOnce = cache((id: string) => getGroup(id));
export const getPurposeOnce = cache((id: string) => getPurpose(id));

const readers: ContextReaders = {
  getProfile: getProfileOnce,
  getTrip: getTripOnce,
  getGroup: getGroupOnce,
  getPurpose: getPurposeOnce,
};

/** Same result as the `getPlanState` action, but built from the request-cached reads and loaded once per request. */
const planStateFor = cache(async (tripId: string, version: number | null): Promise<ActionResult<PlanState>> => {
  if (version !== null && !(Number.isInteger(version) && version >= 1)) return fail("invalid");
  const loaded = await loadPlanContext(tripId, readers);
  if (!loaded.ok) return fail(loaded.error);
  const s = await loadPlanState(loaded.ctx, version ?? undefined);
  return s.ok ? { ok: true, data: s.state } : fail(s.error);
});
// `cache` keys on the argument list, so `(id)` and `(id, undefined)` would be two entries: normalize here.
export const getPlanStateOnce = (tripId: string, version?: number) => planStateFor(tripId, version ?? null);
