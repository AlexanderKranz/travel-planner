import "server-only";
import type { AiCtx } from "@/lib/domain/ai";
import { ITINERARY_IMAGE_TYPES, MAX_ITINERARY_IMAGES, type ItineraryExtractError } from "@/lib/domain/itinerary";
import { detectScreenshotType } from "@/lib/domain/feedback";
import { StoredRawStops, type ExtractDrops, type NormalizedExtract } from "@/lib/itinerary/normalize";
import { berlinMidnight, budgetAllows, getBudgetStatus, isAiEnabled, logAiUsage, type Role } from "./ai-usage";
import { extractItineraryStops, itineraryHash, type ItineraryPayload } from "./ai/itinerary-extract";
import { logEvent } from "./events";
import { rateLimit, rateLimitAvailable } from "./rate-limit";
import type { getUserSession } from "./session";
import { getEffectiveEnv } from "./settings";
import { createSupabaseAdminClient } from "./supabase/admin";

type Session = NonNullable<Awaited<ReturnType<typeof getUserSession>>>;

/** Budget held back for one extraction (spec section 8: at most about 720 µ$ for 3 images; 10x headroom for prices). */
export const RESERVE_ITINERARY = 3_000;
/** AI extractions per Berlin day and user, notes derivations included ([D9]). Demo users: parser only. */
export const DAILY_EXTRACTS = { user: 10, admin: 30 } as const;
/** Per user and minute, in memory ([D9]). */
export const MINUTE_EXTRACTS = 3;
const MINUTE_MS = 60_000;
/** Max decoded size of one image ([D9]). */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const rateKey = (userId: string) => `itinerary:${userId}`;

/**
 * Extractions of this instance that passed the gates but have not logged usage yet, per user. Gates read the
 * `ai_usage` log, which only grows when a call finishes; counting the in-flight ones closes the read-then-charge
 * race between overlapping requests on one instance. Across instances the race remains (same as the other AI tasks).
 */
const inflight = new Map<string, number>();
const release = (userId: string) => {
  const n = (inflight.get(userId) ?? 0) - 1;
  if (n > 0) inflight.set(userId, n);
  else inflight.delete(userId);
};

/**
 * Images as the server receives them: base64 that decodes, at most 2 MB, magic bytes matching the declared type
 * (pattern of `checkScreenshot`). The browser downscaled and re-encoded them; the server checks again.
 */
export function checkImages(images: readonly { mediaType: string; data: string }[]): boolean {
  if (images.length < 1 || images.length > MAX_ITINERARY_IMAGES) return false;
  return images.every((img) => {
    if (!(ITINERARY_IMAGE_TYPES as readonly string[]).includes(img.mediaType)) return false;
    if (img.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(img.data)) return false;
    const bytes = Buffer.from(img.data, "base64");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return false;
    return detectScreenshotType(bytes)?.mime === img.mediaType;
  });
}

/** AI extractions of the user since Berlin midnight, from `ai_usage` (find-destinations [D14] pattern). Throws on a read error. */
export async function countExtractionsToday(userId: string, now: Date = new Date()): Promise<number> {
  const { count, error } = await createSupabaseAdminClient()
    .from("ai_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("task", "itinerary_extract")
    .gte("created_at", berlinMidnight(now).toISOString());
  if (error || count === null) throw new Error("ai_usage read failed");
  return count;
}

/**
 * Cached extraction of this owner for this payload hash, or null. SECRET KEY filtered by owner_id: the row is the
 * owner's (for a notes derivation the trip owner's, also when a write grantee triggers it).
 */
export async function findExtract(ownerId: string, hash: string): Promise<NormalizedExtract | null> {
  try {
    const { data, error } = await createSupabaseAdminClient()
      .from("itinerary_extracts")
      .select("stops, flags")
      .eq("owner_id", ownerId)
      .eq("hash", hash)
      .maybeSingle<{ stops: unknown; flags: unknown }>();
    if (error || !data) return null;
    const stops = StoredRawStops.safeParse(data.stops);
    if (!stops.success) return null;
    const f = (data.flags ?? {}) as Partial<ExtractDrops>;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    return { stops: stops.data, drops: { notInSource: n(f.notInSource), noPlace: n(f.noPlace), invalid: n(f.invalid) } };
  } catch {
    return null;
  }
}

/**
 * Stores the normalized extraction (stops with their per-stop flag codes; drop counts in `flags`). Users have no
 * insert grant on the table, so nobody can plant an extraction that looks machine-made. Best effort.
 */
export async function saveExtract(ownerId: string, hash: string, ex: NormalizedExtract): Promise<void> {
  try {
    await createSupabaseAdminClient()
      .from("itinerary_extracts")
      .upsert({ owner_id: ownerId, hash, stops: ex.stops, flags: ex.drops, created_at: new Date().toISOString() }, { onConflict: "owner_id,hash" });
  } catch {
    // The extraction is still returned; only the next identical payload pays again.
  }
}

export type AiExtractRun =
  | { ok: true; extract: NormalizedExtract; cached: boolean }
  | { ok: false; error: Exclude<ItineraryExtractError, "forbidden" | "invalid" | "no_stops"> };

async function profileOf(session: Session): Promise<{ role: Role; isDemo: boolean }> {
  const { data } = await session.supabase.from("profiles").select("role, is_demo").eq("id", session.userId).maybeSingle();
  return { role: data?.role === "admin" ? "admin" : "user", isDemo: data?.is_demo === true };
}

/**
 * The AI path of section 3.4 for one payload, shared by uploads and notes derivations ([D2]).
 * Order: cache of the owner (also with AI off) → AI switch → demo (parser only) → 3 per minute → 10 per Berlin day
 * (admin 30; an unreadable count fails closed) → budget with RESERVE_ITINERARY → one Haiku call charged to the
 * ACTING user → cache under the OWNER. Never throws. Events carry no content.
 */
export async function runItineraryAi(
  session: Session,
  ownerId: string,
  payload: ItineraryPayload,
  deps: { extract?: typeof extractItineraryStops; now?: Date } = {},
): Promise<AiExtractRun> {
  const hash = itineraryHash(payload);
  const hit = await findExtract(ownerId, hash);
  if (hit) return { ok: true, extract: hit, cached: true };

  const fail = async (error: Exclude<AiExtractRun, { ok: true }>["error"], detail?: string): Promise<AiExtractRun> => {
    const props = { reason: error, ...(detail ? { detail } : {}) };
    await logEvent({ event: "itinerary.extract_failed", level: error === "failed" ? "warn" : "info", userId: session.userId, props });
    return { ok: false, error };
  };

  let held = false;
  try {
    if (!isAiEnabled(await getEffectiveEnv())) return await fail("ai_off");
    const { role, isDemo } = await profileOf(session);
    if (isDemo) return await fail("demo");
    if (!rateLimitAvailable(rateKey(session.userId), MINUTE_EXTRACTS).ok) return await fail("rate_limited");
    const others = inflight.get(session.userId) ?? 0;
    inflight.set(session.userId, others + 1); // taken synchronously, before any await below
    held = true;
    let today: number;
    try {
      today = await countExtractionsToday(session.userId, deps.now);
    } catch {
      return await fail("failed", "usage_read"); // fail closed: an unreadable usage log must not open the gate
    }
    if (today + others >= DAILY_EXTRACTS[role]) return await fail("rate_limited");
    const info = await getBudgetStatus(session.userId, role, isDemo);
    if (!budgetAllows(info, RESERVE_ITINERARY * (others + 1))) return await fail("budget");

    if (!rateLimit(rateKey(session.userId), MINUTE_EXTRACTS, MINUTE_MS).ok) return await fail("rate_limited");
    const ctx: AiCtx = { onUsage: (u) => logAiUsage(session.userId, isDemo, u) };
    const r = await (deps.extract ?? extractItineraryStops)(payload, ctx);
    if (!r.ok) return await fail("failed", r.error);
    await saveExtract(ownerId, hash, r.data);
    return { ok: true, extract: r.data, cached: false };
  } catch {
    return await fail("failed");
  } finally {
    if (held) release(session.userId);
  }
}
