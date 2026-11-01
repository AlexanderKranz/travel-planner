import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { berlinToday } from "@/lib/date";
import { MODEL_IDEAS, type AiCtx } from "@/lib/domain/ai";
import {
  DestinationSearchInput,
  type DestinationSearchView,
  type DropCounts,
} from "@/lib/domain/destination-search";
import type { TripPurpose } from "@/lib/domain/purpose";
import { hasHomeCoords } from "@/lib/domain/profile";
import { zodIssues, type ActionError } from "@/lib/domain/result";
import { ideasInputHash } from "@/lib/discover/hash";
import { buildIdeaInput, type IdeaInput } from "@/lib/discover/input";
import { interestKeysOf } from "@/lib/discover/verifiability";
import { driveHintRadiusKm, homeCell } from "@/lib/drive/estimate";
import { maxBlockMinutes } from "@/lib/flights/constraint";
import { flightRadiusKm, MAX_ORIGINS } from "@/lib/flights/estimate";
import type { GroupSource } from "@/lib/group-text";
import { placeLabel } from "@/lib/geocode-client";
import { isKnownIata } from "@/lib/integrations/airports";
import { getPlaceById } from "@/lib/integrations/open-meteo-geocoding";
import { berlinMidnight, budgetAllows, getBudgetStatus, isAiEnabled, logAiUsage, userCapMicroUsd, type BudgetInfo, type Role } from "../ai-usage";
import { proposeIdeas } from "../ai/destination-ideas";
import { logEvent } from "../events";
import { orsRequestsLeft } from "../facts/ors-quota";
import { getGroup } from "../groups";
import { getProfile } from "../profile";
import { tagAndSave, wantsTags } from "../purpose-tagging";
import { getPurpose } from "../purposes";
import { rateLimit, rateLimitAvailable } from "../rate-limit";
import { getUserSession } from "../session";
import { getEffectiveEnv } from "../settings";
import {
  claimRound1,
  claimRound2,
  countRunsToday,
  failRound,
  finishRound,
  getSearchByHash,
  getSearchById,
  isFresh,
  pruneSearches,
  type NewSearch,
  type StoredSearch,
} from "./store";
import { verifyIdeas } from "./verify";

/** Budget held back for one Haiku ideas call, in micro-USD (est. $0.0004; spec section 9). */
export const RESERVE_IDEAS = 20_000;
const RESERVE_TAGS = 2_000;
/** ORS requests one cold drive round may need (at most 8: 5 cards plus the places that drop; spec section 5). */
export const DRIVE_ROUND_REQUESTS = 8;
/** ORS requests kept for plans (drive times of a plan are a matrix call): a drive search never uses the last 50. */
export const ORS_PLAN_RESERVE = 50;
/** Real runs per Berlin day, counted from ai_usage (spec [D14]). */
export const DAILY_RUNS = { user: 10, admin: 30, demo: 5 } as const;
/** One real run per minute and user protects Open-Meteo's per-minute limit. */
const RUN_WINDOW_MS = 60_000;
const Id = z.string().uuid();

export type SearchError = { ok: false; error: ActionError; resetAt?: string; retryAfter?: number; issues?: { path: string; message: string }[] };
export type SearchResult = { ok: true; data: DestinationSearchView } | SearchError;

const err = (error: ActionError, extra: Partial<SearchError> = {}): SearchError => ({ ok: false, error, ...extra });

type Session = NonNullable<Awaited<ReturnType<typeof getUserSession>>>;
type Ctx = {
  session: Session;
  sb: SupabaseClient;
  userId: string;
  role: Role;
  isDemo: boolean;
  locale: "de" | "en";
  birthdate: string | null;
  homeAirports: string[];
  /** The profile home with coordinates, or null (none, or saved before drive searches existed). */
  home: { name: string; geoId: number; lat: number; lon: number } | null;
};

async function loadCtx(): Promise<{ ok: true; ctx: Ctx } | SearchError> {
  const session = await getUserSession();
  if (!session) return err("unauthenticated");
  const profile = await getProfile();
  if (!profile.ok) return err("failed");
  const p = profile.data;
  return {
    ok: true,
    ctx: {
      session,
      sb: session.supabase as SupabaseClient,
      userId: session.userId,
      role: p.role,
      isDemo: p.isDemo,
      locale: p.locale,
      birthdate: p.birthdate,
      homeAirports: p.homeAirports,
      home: hasHomeCoords(p) ? { name: p.homeLocation!, geoId: p.homeGeoId!, lat: p.homeLat!, lon: p.homeLon! } : null,
    },
  };
}

export function toView(s: StoredSearch, aiEnabled: boolean, cached = false): DestinationSearchView {
  // Internals (input, hash, lock, cost) stay on the server.
  return {
    id: s.id,
    purposeId: s.purposeId,
    groupId: s.groupId,
    purposeName: s.purposeName,
    locale: s.locale,
    months: s.months,
    origins: s.origins,
    travelMode: s.travelMode,
    maxFlightHours: s.maxFlightHours,
    maxDriveHours: s.maxDriveHours,
    homeName: s.homeName,
    radiusKm: s.radiusKm,
    status: s.status,
    rounds: s.rounds,
    cards: s.cards,
    drops: s.drops,
    error: s.error,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    canShowOthers: s.status === "done" && s.rounds === 1 && aiEnabled,
    aiEnabled,
    ...(cached ? { cached: true } : {}),
  };
}

/** Budget status; fails closed (spent = cap) when ai_usage cannot be read, like the plan pipeline. */
async function budgetInfo(c: Ctx): Promise<BudgetInfo> {
  try {
    return await getBudgetStatus(c.userId, c.role, c.isDemo);
  } catch {
    const cap = userCapMicroUsd(c.role, c.isDemo, await getEffectiveEnv());
    return { spentMicroUsd: cap, capMicroUsd: cap, resetsAt: berlinMidnight(new Date(), 1).toISOString(), globalSpentMicroUsd: 1, globalCapMicroUsd: 0 };
  }
}

/** Gates 3 to 5 of spec section 9: AI switch, one run per minute, runs per day. Gate 6 (budget) is `checkBudget`. */
async function gateRun(c: Ctx): Promise<SearchError | null> {
  if (!isAiEnabled(await getEffectiveEnv())) return err("ai_disabled");
  // Only looks: the slot is taken by `takeRunSlot` once budget and claim passed, so a refusal there costs no minute.
  const rl = rateLimitAvailable(`discover:${c.userId}`, 1);
  if (!rl.ok) return err("rate_limited", { retryAfter: rl.retryAfterSeconds });
  const cap = c.isDemo ? DAILY_RUNS.demo : c.role === "admin" ? DAILY_RUNS.admin : DAILY_RUNS.user;
  let runs: number;
  try {
    runs = await countRunsToday(c.userId);
  } catch {
    return err("failed"); // fail closed: an unreadable usage log must not open the gate
  }
  if (runs >= cap) return err("search_limit", { resetAt: berlinMidnight(new Date(), 1).toISOString() });
  return null;
}

/** Counts the one real run per minute; called right after the claim succeeded. */
const takeRunSlot = (c: Ctx) => void rateLimit(`discover:${c.userId}`, 1, RUN_WINDOW_MS);

async function checkBudget(c: Ctx, reserve: number): Promise<SearchError | null> {
  const info = await budgetInfo(c);
  return budgetAllows(info, reserve) ? null : err("budget_exceeded", { resetAt: info.resetsAt });
}

/**
 * The ORS gate of a drive search, right before the first LLM call (spec section 7): the key is set and one cold round
 * plus the plan reserve fit into today's cap. Otherwise no Haiku call is spent on a search that cannot be verified.
 * An unreadable count fails closed.
 */
async function gateDrive(): Promise<SearchError | null> {
  if (!process.env.OPENROUTESERVICE_API_KEY?.trim()) return err("drive_unavailable");
  return (await orsRequestsLeft()) >= DRIVE_ROUND_REQUESTS + ORS_PLAN_RESERVE ? null : err("drive_unavailable");
}

type Start = { name: string; lat: number; lon: number };

/**
 * Start place of a drive search: the one picked in the form (resolved here from its id, never from the browser) or the
 * profile home. Saving it as the profile home is best effort and never fails the search.
 */
async function resolveStart(c: Ctx, input: { homeGeoId?: number; saveHome: boolean }): Promise<{ ok: true; start: Start } | SearchError> {
  if (input.homeGeoId === undefined) return c.home ? { ok: true, start: c.home } : err("home_required");
  let place;
  try {
    place = await getPlaceById(input.homeGeoId, c.locale);
  } catch {
    return err("places_unavailable");
  }
  if (!place) return err("places_unavailable");
  const start = { name: placeLabel(place, c.locale).slice(0, 120), lat: place.lat, lon: place.lon };
  if (input.saveHome && place.timezone) {
    const { error } = await c.sb
      .from("profiles")
      .update({ home_location: start.name, home_timezone: place.timezone, home_geo_id: place.geoId, home_lat: place.lat, home_lon: place.lon })
      .eq("id", c.userId);
    if (error) await logEvent({ event: "destination.search_failed", level: "warn", userId: c.userId, props: { reason: "save_home" } });
  }
  return { ok: true, start };
}

function makeAiCtx(c: Ctx) {
  let cost = 0;
  const ctx: AiCtx = {
    onUsage: async (u) => {
      cost += u.costMicroUsd;
      await logAiUsage(c.userId, c.isDemo, u);
    },
  };
  return { ctx, cost: () => cost };
}

const dropTotal = (d: DropCounts) => Object.values(d).reduce((n, x) => n + (x ?? 0), 0);
const dropDetail = (d: DropCounts) =>
  Object.entries(d)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");

/** Defaults of spec section 2: airports = first two of the profile, limit = the purpose's. A limit without airports is ignored. */
export function resolveSearchParams(
  input: { travelMode?: "flight" | "drive"; origins?: string[]; maxFlightHours?: number | null },
  purpose: TripPurpose,
  homeAirports: readonly string[],
): { ok: true; origins: string[]; maxHours: number | null } | { ok: false; error: "unknown_airport" } {
  // Drive mode: no airports and no flight limit, whatever the profile or the purpose says.
  if (input.travelMode === "drive") return { ok: true, origins: [], maxHours: null };
  const requested = input.origins ?? homeAirports.slice(0, MAX_ORIGINS);
  const origins = [...new Set(requested.map((o) => o.toUpperCase()))].slice(0, MAX_ORIGINS);
  if (origins.some((o) => !isKnownIata(o))) return { ok: false, error: "unknown_airport" };
  const fromPurpose = maxBlockMinutes(purpose);
  const wanted = input.maxFlightHours !== undefined ? input.maxFlightHours : fromPurpose === null ? null : Math.round((fromPurpose / 60) * 10) / 10;
  return { ok: true, origins, maxHours: origins.length > 0 ? wanted : null };
}

/**
 * POST /api/destination-search. Gates in order (spec section 9): session, Zod, purpose through RLS; saved list with
 * the same hash (also with AI off); AI switch; 1 run per minute; runs per day; budget; one running search per user.
 * The client abort is not forwarded: the server finishes and saves, the page polls the row.
 */
export async function runDestinationSearch(raw: unknown): Promise<SearchResult> {
  const loaded = await loadCtx();
  if (!loaded.ok) return loaded;
  const c = loaded.ctx;
  const parsed = DestinationSearchInput.safeParse(raw);
  if (!parsed.success) return err("invalid", { issues: zodIssues(parsed.error).slice(0, 10) });
  const input = parsed.data;

  const pr = await getPurpose(input.purposeId);
  if (!pr.ok) return err(pr.error === "not_found" || pr.error === "invalid" ? "not_found" : "failed");
  let purpose: TripPurpose = pr.data;
  let group: GroupSource | null = null;
  if (input.groupId) {
    const g = await getGroup(input.groupId);
    if (!g.ok) return err(g.error === "not_found" || g.error === "invalid" ? "not_found" : "failed");
    group = g.data;
  }
  const params = resolveSearchParams(input, purpose, c.homeAirports);
  if (!params.ok) return err(params.error);
  const months = [...new Set(input.months)].sort((a, b) => a - b);
  const isDrive = input.travelMode === "drive";
  let start: Start | null = null;
  if (isDrive) {
    const s = await resolveStart(c, input);
    if (!s.ok) return s;
    start = s.start;
  }
  const maxDriveHours = isDrive ? input.maxDriveHours! : null; // the schema requires it in drive mode
  const radiusKm = isDrive ? driveHintRadiusKm(maxDriveHours!) : params.maxHours !== null ? flightRadiusKm(params.maxHours) : null;
  const aiEnabled = isAiEnabled(await getEffectiveEnv());

  const build = (p: TripPurpose): { input: IdeaInput; hash: string } => {
    const ideaInput = buildIdeaInput({
      lang: c.locale,
      purpose: p,
      months,
      origins: params.origins,
      radiusKm: radiusKm ?? undefined,
      ...(start ? { drive: { homeName: start.name, homeCell: homeCell(start) } } : {}),
      group,
      profileBirthdate: c.birthdate,
      today: berlinToday(),
    });
    return { input: ideaInput, hash: ideasInputHash(ideaInput) };
  };

  try {
    let built = build(purpose);
    // Gate 2: the saved list of this owner for the same input; a hit costs nothing and works with AI off.
    let existing = await getSearchByHash(c.sb, built.hash);
    // Served as is: a fresh finished list, or the same search still running (its lock has not run out; an expired
    // lock already reads as `failed`). A failed or older list is taken over in place by the new run.
    const served = (s: StoredSearch | null): SearchResult | null =>
      s && (isFresh(s) || s.status === "running") ? { ok: true, data: toView(s, aiEnabled, true) } : null;
    const hit = served(existing);
    if (hit) {
      await logEvent({ event: "destination.searched", userId: c.userId, props: { cards: existing!.cards.length, rounds: existing!.rounds, cached: true } });
      return hit;
    }

    const gated = await gateRun(c);
    if (gated) return gated;
    const needTags = wantsTags(purpose);
    const blocked = await checkBudget(c, RESERVE_IDEAS + (needTags ? RESERVE_TAGS : 0));
    if (blocked) return blocked;
    if (isDrive) {
      const noDrive = await gateDrive(); // before any Haiku call, tags included
      if (noDrive) return noDrive;
    }

    const ai = makeAiCtx(c);
    if (needTags) {
      // Tags are part of the hash: tag first, then look the saved lists up again (a tagged list may exist).
      purpose = await tagAndSave(c.userId, purpose, ai.ctx);
      const before = built.hash;
      built = build(purpose);
      if (built.hash !== before) {
        existing = await getSearchByHash(c.sb, built.hash);
        const again = served(existing);
        if (again) return again;
      }
    }

    const claim = await claimRound1(
      c.sb,
      {
        purposeId: purpose.id,
        groupId: input.groupId,
        purposeName: purpose.name,
        locale: c.locale,
        months,
        origins: params.origins,
        maxFlightHours: params.maxHours,
        radiusKm,
        travelMode: input.travelMode,
        maxDriveHours,
        home: start,
        inputHash: built.hash,
        input: built.input,
        model: MODEL_IDEAS,
      } satisfies NewSearch,
      existing?.id ?? null, // not served above, so it is failed or older than 30 days: reuse the row
    );
    if (!claim.ok) {
      if (claim.reason === "busy") return err("busy");
      const again = await getSearchByHash(c.sb, built.hash);
      return again ? { ok: true, data: toView(again, aiEnabled, true) } : err("busy");
    }
    takeRunSlot(c);
    return await executeRound(c, claim.search, 1, built.input, ai, null);
  } catch {
    await logEvent({ event: "destination.search_failed", level: "warn", userId: c.userId, props: { reason: "exception" } });
    return err("failed");
  }
}

/** POST /api/destination-search/[id]/more: round 2 on the same row. Same gates; the budget reserve covers one call. */
export async function showOtherDestinations(id: string): Promise<SearchResult> {
  const loaded = await loadCtx();
  if (!loaded.ok) return loaded;
  const c = loaded.ctx;
  if (!Id.safeParse(id).success) return err("not_found");
  try {
    const row = await getSearchById(c.sb, id);
    if (!row) return err("not_found");
    if (row.status === "running") return err("busy");
    // Failed lists and lists that already used their second round cannot ask again.
    if (row.status !== "done" || row.rounds !== 1 || !row.input) return err("conflict");
    const gated = await gateRun(c);
    if (gated) return gated;
    const blocked = await checkBudget(c, RESERVE_IDEAS);
    if (blocked) return blocked;
    if (row.travelMode === "drive") {
      const noDrive = await gateDrive();
      if (noDrive) return noDrive;
    }
    const claim = await claimRound2(c.sb, id);
    if (!claim.ok) return err(claim.reason === "busy" ? "busy" : "conflict");
    takeRunSlot(c);
    const exclude = row.input.exclude?.length ? row.input.exclude : row.cards.map((x) => x.placeName);
    return await executeRound(c, claim.search, 2, { ...row.input, exclude }, makeAiCtx(c), row);
  } catch {
    await logEvent({ event: "destination.search_failed", level: "warn", userId: c.userId, props: { reason: "exception" } });
    return err("failed");
  }
}

/** GET /api/destination-search/[id]: the row (RLS), polled while it is running. */
export async function getDestinationSearch(id: string): Promise<SearchResult> {
  const session = await getUserSession();
  if (!session) return err("unauthenticated");
  if (!Id.safeParse(id).success) return err("not_found");
  try {
    const row = await getSearchById(session.supabase as SupabaseClient, id);
    if (!row) return err("not_found");
    return { ok: true, data: toView(row, isAiEnabled(await getEffectiveEnv())) };
  } catch {
    return err("failed");
  }
}

/** One LLM round: ideas -> verification -> save. Any failure leaves the row not running. */
async function executeRound(
  c: Ctx,
  claimed: StoredSearch,
  round: 1 | 2,
  ideaInput: IdeaInput,
  ai: { ctx: AiCtx; cost: () => number },
  previous: StoredSearch | null,
): Promise<SearchResult> {
  const started = Date.now();
  const giveUp = async (error: ActionError, reason: string): Promise<SearchResult> => {
    await failRound(c.sb, claimed.id, { round, error, costMicroUsd: ai.cost(), previous });
    await logEvent({ event: "destination.search_failed", level: "warn", userId: c.userId, props: { reason, round, costMicroUsd: ai.cost() } });
    return err(error);
  };
  try {
    const res = await proposeIdeas(ideaInput, ai.ctx);
    if (!res.ok) return await giveUp(res.error, res.error);
    const ideas = res.data;

    const out = ideas.length
      ? await verifyIdeas({
          ideas,
          round,
          lang: c.locale,
          userId: c.userId,
          today: berlinToday(),
          months: claimed.months,
          origins: claimed.origins,
          maxHours: claimed.maxFlightHours,
          // Drive mode uses the start saved on the row, so round 2 is unchanged by a new profile home.
          ...(claimed.travelMode === "drive" && claimed.maxDriveHours !== null && claimed.homeLat !== null && claimed.homeLon !== null
            ? { drive: { home: { lat: claimed.homeLat, lon: claimed.homeLon }, maxHours: claimed.maxDriveHours } }
            : {}),
          interests: interestKeysOf(ideaInput.purpose.interests),
          existing: previous?.cards ?? [],
        })
      : { cards: [], drops: {} as DropCounts, reasonsRemoved: 0, geocodeDown: false, driveDown: false, stoppedBy: null, climateMisses: 0, driveLookups: 0 };
    // Geocoding down: nothing was verified, so nothing may be shown (spec section 9).
    if (out.geocodeDown) return await giveUp("places_unavailable", "geocoding_down");
    // Drive mode: ORS failed on the first two places, so no drive can be verified (D10, same exception as geocoding).
    if (out.driveDown) return await giveUp("drive_unavailable", "drive_down");

    // The anchors of every idea (also dropped ones) are what "Show others" must not propose again.
    const exclude = [...new Set([...(ideaInput.exclude ?? []), ...ideas.map((i) => i.anchor)])];
    const saved = await finishRound(c.sb, claimed.id, {
      round,
      cards: out.cards,
      drops: out.drops,
      costMicroUsd: ai.cost(),
      input: round === 1 ? { ...ideaInput, exclude } : (previous?.input ?? ideaInput),
      previous,
    });
    await pruneSearches(c.sb, saved.id);
    await logEvent({
      event: "destination.searched",
      userId: c.userId,
      props: {
        cards: out.cards.length,
        drops: dropTotal(out.drops),
        dropsDetail: dropDetail(out.drops),
        rounds: round,
        cached: false,
        durationMs: Date.now() - started,
        costMicroUsd: ai.cost(),
        reasonsRemoved: out.reasonsRemoved,
        climateMisses: out.climateMisses,
        stoppedBy: out.stoppedBy,
        travelMode: claimed.travelMode,
        driveLookups: out.driveLookups,
      },
    });
    return { ok: true, data: toView(saved, true) }; // the AI gate passed for this run
  } catch {
    return await giveUp("failed", "exception");
  }
}
