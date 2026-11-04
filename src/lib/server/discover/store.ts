import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SEARCH_CACHE_DAYS,
  SEARCHES_KEPT_PER_USER,
  SearchDrops,
  SuggestionCards,
  type DestinationSearch,
  type DropCounts,
  type SuggestionCard,
} from "@/lib/domain/destination-search";
import { PurposeTags } from "@/lib/domain/plan";
import type { ActionError } from "@/lib/domain/result";
import type { IdeaInput } from "@/lib/discover/input";
import { oneOffLabel, oneOffTagsHash } from "@/lib/discover/one-off";
import { berlinMidnight } from "../ai-usage";
import { createSupabaseAdminClient } from "../supabase/admin";

/**
 * Persistence of destination searches with the USER session (RLS applies), like plans (phase 3 D2). A user could only
 * forge rows they alone see, and `createTrip` never trusts their contents. The one secret-key read is the daily run
 * count from `ai_usage` (users cannot read other users' rows, and can delete their own searches).
 */

/** An in-flight search is taken over after this long (route maxDuration is 120 s). */
export const SEARCH_LOCK_MS = 150_000;
const UNIQUE_VIOLATION = "23505";

export const SEARCH_COLUMNS =
  "id, purpose_id, group_id, purpose_name, purpose_text, locale, months, origins, max_flight_hours, radius_km, travel_mode, max_drive_hours, home_name, home_lat, home_lon, input_hash, input, status, busy_until, rounds, cards, drops, error_code, model, cost_micro_usd, created_at, updated_at";

export type SearchRow = {
  id: string;
  purpose_id: string | null;
  group_id: string | null;
  purpose_name: string;
  purpose_text: string | null;
  locale: "de" | "en";
  months: number[];
  origins: string[];
  max_flight_hours: number | string | null;
  radius_km: number | null;
  travel_mode: "flight" | "drive";
  max_drive_hours: number | string | null;
  home_name: string | null;
  home_lat: number | null;
  home_lon: number | null;
  input_hash: string;
  input: unknown;
  status: "running" | "done" | "failed";
  busy_until: string | null;
  rounds: number;
  cards: unknown;
  drops: unknown;
  error_code: string | null;
  model: string | null;
  cost_micro_usd: number;
  created_at: string;
  updated_at: string;
};

/** A stored search with the internals the pipeline needs (`input`, `inputHash`, lock). */
export type StoredSearch = DestinationSearch & {
  inputHash: string;
  input: IdeaInput | null;
  busyUntil: string | null;
  costMicroUsd: number;
  /** Drive mode: the start coordinates snapshot. Server only: never part of the view. */
  homeLat: number | null;
  homeLon: number | null;
};

const ERROR_CODES: readonly ActionError[] = ["ai_unavailable", "ai_refused", "invalid_output", "places_unavailable", "drive_unavailable", "failed"];

export function rowToSearch(r: SearchRow): StoredSearch {
  const cards = SuggestionCards.safeParse(r.cards);
  const drops = SearchDrops.safeParse(r.drops);
  const input = r.input && typeof r.input === "object" && (r.input as { v?: unknown }).v === 1 ? (r.input as IdeaInput) : null;
  const lockLost = r.status === "running" && isExpired(r.busy_until);
  // A killed "Show others" (round 1 cards, round still 1) is a finished list again, not a failed one.
  const restored = lockLost && r.rounds === 1 && cards.success && cards.data.length > 0;
  const knownError = ERROR_CODES.find((e) => e === r.error_code) ?? null;
  return {
    id: r.id,
    purposeId: r.purpose_id,
    groupId: r.group_id,
    purposeName: r.purpose_name,
    purposeText: r.purpose_text ?? null,
    locale: r.locale,
    months: r.months,
    origins: r.origins,
    travelMode: r.travel_mode === "drive" ? "drive" : "flight",
    maxFlightHours: r.max_flight_hours === null ? null : Number(r.max_flight_hours),
    maxDriveHours: r.max_drive_hours === null || r.max_drive_hours === undefined ? null : Number(r.max_drive_hours),
    homeName: r.home_name ?? null,
    radiusKm: r.radius_km,
    // A lock that ran out means the server died mid-run: report it as failed, never as running forever.
    status: restored ? "done" : lockLost ? "failed" : r.status,
    rounds: r.rounds === 2 ? 2 : 1,
    cards: cards.success ? cards.data : [],
    drops: drops.success ? drops.data : {},
    error: restored ? null : lockLost ? "failed" : (knownError ?? (r.status === "failed" ? "failed" : null)),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    inputHash: r.input_hash,
    input,
    busyUntil: r.busy_until,
    costMicroUsd: r.cost_micro_usd,
    homeLat: r.home_lat ?? null,
    homeLon: r.home_lon ?? null,
  };
}

export function isExpired(busyUntil: string | null, now: number = Date.now()): boolean {
  return !busyUntil || Date.parse(busyUntil) <= now;
}

/**
 * True when a saved list may be served for the same input (done, younger than 30 days). Measured from updated_at:
 * a failed or old list is reused in place, so created_at would keep it old forever.
 */
export function isFresh(s: Pick<StoredSearch, "status" | "updatedAt"> & { drops?: DestinationSearch["drops"] }, now: number = Date.now()): boolean {
  if (s.status !== "done") return false;
  // Places whose drive could not be verified never return on their own: an identical search runs again after an hour.
  const ttl = hasDriveGap(s.drops ?? {}) ? DRIVE_GAP_RETRY_MS : SEARCH_CACHE_DAYS * 86_400_000;
  return now - Date.parse(s.updatedAt) < ttl;
}

/** A list with unverified drives is served for this long only (ORS was down or limited). */
export const DRIVE_GAP_RETRY_MS = 60 * 60_000;
export const hasDriveGap = (drops: DestinationSearch["drops"]): boolean =>
  (["1", "2"] as const).some((k) => (drops[k]?.drive_failed ?? 0) > 0);

export async function getSearchById(sb: SupabaseClient, id: string): Promise<StoredSearch | null> {
  const { data, error } = await sb.from("destination_searches").select(SEARCH_COLUMNS).eq("id", id).maybeSingle<SearchRow>();
  if (error) throw new Error("search read failed");
  return data ? rowToSearch(data) : null;
}

export async function getSearchByHash(sb: SupabaseClient, hash: string): Promise<StoredSearch | null> {
  const { data, error } = await sb.from("destination_searches").select(SEARCH_COLUMNS).eq("input_hash", hash).maybeSingle<SearchRow>();
  if (error) throw new Error("search read failed");
  return data ? rowToSearch(data) : null;
}

/** Newest first, for the list of earlier searches. */
export async function listSearches(sb: SupabaseClient): Promise<StoredSearch[]> {
  const { data, error } = await sb
    .from("destination_searches")
    .select(SEARCH_COLUMNS)
    .order("updated_at", { ascending: false })
    .limit(SEARCHES_KEPT_PER_USER)
    .returns<SearchRow[]>();
  if (error) throw new Error("search read failed");
  return data.map(rowToSearch);
}

// ---------- one-off purpose (spec section 13) ----------

/** Tags stored on a search row or purpose with the hash they were made for. */
export type FoundTags = { tags: PurposeTags; from: "search" | "purpose" };

/**
 * Tag lookup of spec 13.2, user session: this owner's searches with `purpose_tags_hash = hash` (newest first), then
 * this owner's purposes with `parsed_hash = hash`. `purposeTagsHash` covers exactly text, constraints and custom
 * interests, so equal hashes mean the tags were made from the same input. Invalid stored tags count as missing.
 * Throws on a read error: the caller fails closed instead of spending a Haiku call on a failed read.
 */
export async function findTagsByHash(sb: SupabaseClient, hash: string): Promise<FoundTags | null> {
  const fromSearch = await sb
    .from("destination_searches")
    .select("purpose_tags")
    .eq("purpose_tags_hash", hash)
    .order("updated_at", { ascending: false })
    .limit(5)
    .returns<{ purpose_tags: unknown }[]>();
  if (fromSearch.error) throw new Error("search read failed");
  for (const r of fromSearch.data ?? []) {
    const t = PurposeTags.safeParse(r.purpose_tags);
    if (t.success) return { tags: t.data, from: "search" };
  }
  const fromPurpose = await sb
    .from("trip_purposes")
    .select("parsed_tags")
    .eq("parsed_hash", hash)
    .order("updated_at", { ascending: false })
    .limit(5)
    .returns<{ parsed_tags: unknown }[]>();
  if (fromPurpose.error) throw new Error("purpose read failed");
  for (const r of fromPurpose.data ?? []) {
    const t = PurposeTags.safeParse(r.parsed_tags);
    if (t.success) return { tags: t.data, from: "purpose" };
  }
  return null;
}

/**
 * Writes the tags and their hash onto a search row. SECRET KEY (RLS bypass) on purpose: users have no grant on
 * `purpose_tags` / `purpose_tags_hash` (like `trip_purposes.parsed_*`), because "Save as purpose" copies them without a
 * new LLM call. The owner_id filter keeps the write scoped to the requesting user's own row. Best effort.
 */
export async function saveSearchTags(userId: string, searchId: string, tags: PurposeTags, hash: string): Promise<boolean> {
  try {
    const { data, error } = await createSupabaseAdminClient()
      .from("destination_searches")
      .update({ purpose_tags: tags, purpose_tags_hash: hash })
      .eq("id", searchId)
      .eq("owner_id", userId)
      .select("id");
    if (error || data.length !== 1) {
      console.error("search tags write failed", error?.code ?? "no row");
      return false;
    }
    return true;
  } catch {
    console.error("search tags write failed");
    return false;
  }
}

/** The stored tags and hash of one row (user session; the columns are readable by their owner). */
export async function getSearchTags(sb: SupabaseClient, id: string): Promise<{ tags: PurposeTags; hash: string } | null> {
  const { data, error } = await sb
    .from("destination_searches")
    .select("purpose_tags, purpose_tags_hash")
    .eq("id", id)
    .maybeSingle<{ purpose_tags: unknown; purpose_tags_hash: string | null }>();
  if (error) throw new Error("search read failed");
  if (!data?.purpose_tags_hash) return null;
  const t = PurposeTags.safeParse(data.purpose_tags);
  return t.success ? { tags: t.data, hash: data.purpose_tags_hash } : null;
}

/** The purpose source of the current run request (spec 13.3). */
export type SourceRequest =
  | { kind: "saved"; purposeId: string; name: string }
  | { kind: "text"; text: string; tags: PurposeTags | null };

/**
 * A served row takes the purpose source of the current request (spec 13.3, ADR 0009 decision 4), so the trip draft and
 * "Save as purpose" follow the latest request. Every path that returns an existing row for a run request goes through
 * here. A matching row is returned unchanged and nothing is written. Otherwise the row is updated with the user
 * session (all three columns are granted), also while it is running (`finishRound` and `failRound` never write them).
 * A text request that relabels a row also stores the tags it has for that text.
 */
export async function adoptSource(
  sb: SupabaseClient,
  userId: string,
  row: StoredSearch,
  req: SourceRequest,
): Promise<{ search: StoredSearch; relabelled: boolean }> {
  const patch =
    req.kind === "saved"
      ? row.purposeId === req.purposeId
        ? null
        : { purpose_id: req.purposeId, purpose_name: req.name.slice(0, 80), purpose_text: null }
      : row.purposeText === req.text
        ? null
        : { purpose_id: null, purpose_name: oneOffLabel(req.text), purpose_text: req.text };
  if (!patch) return { search: row, relabelled: false };
  const { data, error } = await sb.from("destination_searches").update(patch).eq("id", row.id).select(SEARCH_COLUMNS).maybeSingle<SearchRow>();
  if (error) throw new Error("search write failed");
  if (req.kind === "text" && req.tags) await saveSearchTags(userId, row.id, req.tags, oneOffTagsHash(req.text));
  const search: StoredSearch = data
    ? rowToSearch(data)
    : { ...row, purposeId: patch.purpose_id, purposeName: patch.purpose_name, purposeText: patch.purpose_text };
  return { search, relabelled: true };
}

/** Runs whose lock ran out become `failed`, so the one-running-per-user index cannot block forever. */
export async function expireStaleRuns(sb: SupabaseClient, now: number = Date.now()): Promise<void> {
  const { data, error } = await sb
    .from("destination_searches")
    .select("id, cards, rounds")
    .eq("status", "running")
    .lt("busy_until", new Date(now).toISOString())
    .returns<{ id: string; cards: unknown; rounds: number }[]>();
  if (error) throw new Error("search read failed");
  for (const row of data ?? []) {
    // A killed "Show others" keeps its round-1 list (done, no new call); a killed first run is failed.
    const keep = row.rounds === 1 && Array.isArray(row.cards) && row.cards.length > 0;
    const patch = keep ? { status: "done", busy_until: null } : { status: "failed", busy_until: null, error_code: "failed" };
    const { error: e } = await sb.from("destination_searches").update(patch).eq("id", row.id).eq("status", "running");
    if (e) throw new Error("search update failed");
  }
}

export type NewSearch = {
  /** null for a typed one-off (spec 13.3). */
  purposeId: string | null;
  groupId: string | null;
  purposeName: string;
  /** The typed text of a one-off, else null (a taken-over row must not keep the text of an earlier request). */
  purposeText: string | null;
  locale: "de" | "en";
  months: number[];
  origins: string[];
  maxFlightHours: number | null;
  radiusKm: number | null;
  travelMode: "flight" | "drive";
  maxDriveHours: number | null;
  /** Drive mode: snapshot of the start, so "Show others" uses the same one even if the profile home changes. */
  home: { name: string; lat: number; lon: number } | null;
  inputHash: string;
  input: IdeaInput;
  model: string;
};

const startedColumns = (n: NewSearch, now: number) => ({
  purpose_id: n.purposeId,
  group_id: n.groupId,
  purpose_name: n.purposeName.slice(0, 80),
  purpose_text: n.purposeText,
  locale: n.locale,
  months: n.months,
  origins: n.origins,
  max_flight_hours: n.maxFlightHours,
  radius_km: n.radiusKm,
  travel_mode: n.travelMode,
  max_drive_hours: n.maxDriveHours,
  home_name: n.home?.name.slice(0, 120) ?? null,
  home_lat: n.home?.lat ?? null,
  home_lon: n.home?.lon ?? null,
  input: n.input,
  model: n.model,
  status: "running" as const,
  busy_until: new Date(now + SEARCH_LOCK_MS).toISOString(),
  rounds: 1,
  cards: [],
  drops: {},
  error_code: null,
  cost_micro_usd: 0,
});

export type ClaimResult = { ok: true; search: StoredSearch } | { ok: false; reason: "busy" | "exists" };

/**
 * Starts round 1: a new row, or the row of the same hash (failed, or older than 30 days) taken over in place.
 * Another running search of this user hits the partial unique index: `busy`. A row with the same hash that appeared
 * meanwhile (a double click): `exists`, the caller reloads it.
 */
export async function claimRound1(sb: SupabaseClient, n: NewSearch, reuseId: string | null, now: number = Date.now()): Promise<ClaimResult> {
  await expireStaleRuns(sb, now);
  const cols = startedColumns(n, now);
  if (reuseId) {
    const { data, error } = await sb
      .from("destination_searches")
      .update(cols)
      .eq("id", reuseId)
      .neq("status", "running")
      .select(SEARCH_COLUMNS)
      .maybeSingle<SearchRow>();
    if (error) return error.code === UNIQUE_VIOLATION ? { ok: false, reason: "busy" } : failNow();
    return data ? { ok: true, search: rowToSearch(data) } : { ok: false, reason: "exists" };
  }
  const { data, error } = await sb
    .from("destination_searches")
    .insert({ ...cols, input_hash: n.inputHash })
    .select(SEARCH_COLUMNS)
    .single<SearchRow>();
  if (error) {
    if (error.code !== UNIQUE_VIOLATION) return failNow();
    // Which unique index? The hash index means an identical search just started; the running index means another one.
    return (await getSearchByHash(sb, n.inputHash)) ? { ok: false, reason: "exists" } : { ok: false, reason: "busy" };
  }
  return { ok: true, search: rowToSearch(data) };
}

function failNow(): never {
  throw new Error("search write failed");
}

/** Starts round 2 on a finished list with an unused round. */
export async function claimRound2(sb: SupabaseClient, id: string, now: number = Date.now()): Promise<ClaimResult> {
  await expireStaleRuns(sb, now);
  const { data, error } = await sb
    .from("destination_searches")
    .update({ status: "running", busy_until: new Date(now + SEARCH_LOCK_MS).toISOString(), error_code: null })
    .eq("id", id)
    .eq("status", "done")
    .eq("rounds", 1)
    .select(SEARCH_COLUMNS)
    .maybeSingle<SearchRow>();
  if (error) return error.code === UNIQUE_VIOLATION ? { ok: false, reason: "busy" } : failNow();
  return data ? { ok: true, search: rowToSearch(data) } : { ok: false, reason: "exists" };
}

/** Writes the result of a round. Round 2 appends to the cards and drops of round 1. */
export async function finishRound(
  sb: SupabaseClient,
  id: string,
  p: { round: 1 | 2; cards: SuggestionCard[]; drops: DropCounts; costMicroUsd: number; input: IdeaInput; previous: StoredSearch | null },
): Promise<StoredSearch> {
  const allCards = p.round === 2 && p.previous ? [...p.previous.cards, ...p.cards] : p.cards;
  const allDrops = { ...(p.previous?.drops ?? {}), [String(p.round)]: p.drops };
  const { data, error } = await sb
    .from("destination_searches")
    .update({
      status: "done",
      busy_until: null,
      rounds: p.round,
      cards: allCards,
      drops: allDrops,
      input: p.input,
      error_code: null,
      cost_micro_usd: (p.previous?.costMicroUsd ?? 0) + p.costMicroUsd,
    })
    .eq("id", id)
    .select(SEARCH_COLUMNS)
    .single<SearchRow>();
  if (error) throw new Error("search write failed");
  return rowToSearch(data);
}

/**
 * A failed round. Round 1: the row is `failed` (reused by the next attempt). Round 2: the list goes back to `done`
 * with its round-1 cards and the round stays unused, so one failed call does not take the cards away.
 */
export async function failRound(
  sb: SupabaseClient,
  id: string,
  p: { round: 1 | 2; error: ActionError; costMicroUsd: number; previous: StoredSearch | null },
): Promise<void> {
  const cost = (p.previous?.costMicroUsd ?? 0) + p.costMicroUsd;
  const patch =
    p.round === 2
      ? { status: "done", busy_until: null, cost_micro_usd: cost }
      : { status: "failed", busy_until: null, error_code: p.error, cost_micro_usd: cost };
  const { error } = await sb.from("destination_searches").update(patch).eq("id", id);
  if (error) console.error("search fail write failed", error.code);
}

/** Keeps the newest 10 per user (spec [D12]); never deletes `keepId`. Best effort. */
export async function pruneSearches(sb: SupabaseClient, keepId: string): Promise<void> {
  try {
    const { data, error } = await sb
      .from("destination_searches")
      .select("id")
      .order("updated_at", { ascending: false })
      .range(SEARCHES_KEPT_PER_USER, SEARCHES_KEPT_PER_USER + 50)
      .returns<{ id: string }[]>();
    if (error || !data) return;
    const ids = data.map((r) => r.id).filter((id) => id !== keepId);
    if (ids.length > 0) await sb.from("destination_searches").delete().in("id", ids);
  } catch {
    // Retention is best effort; the nightly purge also deletes rows older than 90 days.
  }
}

/**
 * Real LLM runs of this user since Berlin midnight, from `ai_usage` (task destination_ideas). SECRET KEY (RLS
 * bypass) on purpose: counted from the usage log rather than the table, because users can delete their own
 * searches. Filtered to the one user id. Throws on a read error (the caller fails closed).
 */
export async function countRunsToday(userId: string, now: Date = new Date()): Promise<number> {
  const { count, error } = await createSupabaseAdminClient()
    .from("ai_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("task", "destination_ideas")
    .gte("created_at", berlinMidnight(now).toISOString());
  if (error || count === null) throw new Error("ai_usage read failed");
  return count;
}
