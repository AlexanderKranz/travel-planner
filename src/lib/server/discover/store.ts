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
import type { ActionError } from "@/lib/domain/result";
import type { IdeaInput } from "@/lib/discover/input";
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
  "id, purpose_id, group_id, purpose_name, locale, months, origins, max_flight_hours, radius_km, input_hash, input, status, busy_until, rounds, cards, drops, error_code, model, cost_micro_usd, created_at, updated_at";

export type SearchRow = {
  id: string;
  purpose_id: string | null;
  group_id: string | null;
  purpose_name: string;
  locale: "de" | "en";
  months: number[];
  origins: string[];
  max_flight_hours: number | string | null;
  radius_km: number | null;
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
export type StoredSearch = DestinationSearch & { inputHash: string; input: IdeaInput | null; busyUntil: string | null; costMicroUsd: number };

const ERROR_CODES: readonly ActionError[] = ["ai_unavailable", "ai_refused", "invalid_output", "places_unavailable", "failed"];

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
    locale: r.locale,
    months: r.months,
    origins: r.origins,
    maxFlightHours: r.max_flight_hours === null ? null : Number(r.max_flight_hours),
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
  };
}

export function isExpired(busyUntil: string | null, now: number = Date.now()): boolean {
  return !busyUntil || Date.parse(busyUntil) <= now;
}

/**
 * True when a saved list may be served for the same input (done, younger than 30 days). Measured from updated_at:
 * a failed or old list is reused in place, so created_at would keep it old forever.
 */
export function isFresh(s: Pick<StoredSearch, "status" | "updatedAt">, now: number = Date.now()): boolean {
  return s.status === "done" && now - Date.parse(s.updatedAt) < SEARCH_CACHE_DAYS * 86_400_000;
}

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
  purposeId: string;
  groupId: string | null;
  purposeName: string;
  locale: "de" | "en";
  months: number[];
  origins: string[];
  maxFlightHours: number | null;
  radiusKm: number | null;
  inputHash: string;
  input: IdeaInput;
  model: string;
};

const startedColumns = (n: NewSearch, now: number) => ({
  purpose_id: n.purposeId,
  group_id: n.groupId,
  purpose_name: n.purposeName.slice(0, 80),
  locale: n.locale,
  months: n.months,
  origins: n.origins,
  max_flight_hours: n.maxFlightHours,
  radius_km: n.radiusKm,
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
