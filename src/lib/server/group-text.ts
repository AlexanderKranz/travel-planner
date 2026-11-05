import "server-only";
import type { GroupParse } from "@/lib/domain/group-text";
import { groupTextHash } from "@/lib/plan/hash";
import { budgetAllows, getBudgetStatus, isAiEnabled, logAiUsage, type Role } from "./ai-usage";
import { parseGroupText } from "./ai/group-parse";
import { logEvent } from "./events";
import { rateLimit } from "./rate-limit";
import type { getUserSession } from "./session";
import { createSupabaseAdminClient } from "./supabase/admin";
import { getEffectiveEnv } from "./settings";

type Session = NonNullable<Awaited<ReturnType<typeof getUserSession>>>;

/** Same reserve as the purpose tagging step: a Haiku call costs well below a thousandth of a dollar. */
const RESERVE_GROUP_PARSE = 2_000;

/** `ownerId` = owner of the ROW (read through RLS before), not necessarily the acting user (a write grantee of a shared trip). */
export type ParseTarget = { table: "travel_groups"; id: string; ownerId: string } | { table: "trips"; id: string; ownerId: string };

/** Column names of the parse cache per table (the user session has no grant on them). */
const CACHE_COLUMNS = {
  travel_groups: { parsed: "parsed_structure", hash: "parsed_hash", at: "parsed_at" },
  trips: { parsed: "group_parsed", hash: "group_parsed_hash", at: "group_parsed_at" },
} as const;

/**
 * Caches the Haiku parse on the group / trip. SECRET KEY (RLS bypass) on purpose: users have no grant on the
 * parse columns (they could otherwise plant a structure that looks machine-made). The owner_id filter (the row's owner,
 * `target.ownerId`) keeps the write scoped to the one row the caller already read through RLS. The AI call that made the
 * parse stays charged to the acting user (`ensureGroupParse`).
 */
export async function saveGroupParse(target: ParseTarget, parse: GroupParse, hash: string): Promise<boolean> {
  const c = CACHE_COLUMNS[target.table];
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from(target.table)
      .update({ [c.parsed]: parse, [c.hash]: hash, [c.at]: new Date().toISOString() })
      .eq("id", target.id)
      .eq("owner_id", target.ownerId)
      .select("id");
    return !error && data.length === 1;
  } catch {
    return false;
  }
}

/**
 * Once per text change: Haiku turns the free-text group into travellers, cached by text hash on the row.
 * Best effort and never throws: no AI (kill switch), rate limit, budget or a failed call simply leave the group
 * without a parse (the plan then gets the raw text). Returns true when a new parse was saved.
 */
export async function ensureGroupParse(
  session: Session,
  target: ParseTarget,
  text: string | undefined,
  hasValidParse: boolean,
): Promise<boolean> {
  const clean = text?.trim();
  if (!clean || hasValidParse || !isAiEnabled(await getEffectiveEnv())) return false;
  try {
    if (!rateLimit(`group-parse:${session.userId}`, 20, 60_000).ok) return false;
    const { data } = await session.supabase.from("profiles").select("role, is_demo").eq("id", session.userId).maybeSingle();
    const role: Role = data?.role === "admin" ? "admin" : "user";
    const isDemo = data?.is_demo === true;
    const info = await getBudgetStatus(session.userId, role, isDemo);
    if (!budgetAllows(info, RESERVE_GROUP_PARSE)) return false;
    const res = await parseGroupText(clean, { onUsage: (u) => logAiUsage(session.userId, isDemo, u) });
    if (!res.ok) {
      await logEvent({ event: "group.parse_failed", level: "warn", userId: session.userId, props: { table: target.table, reason: res.error } });
      return false;
    }
    return await saveGroupParse(target, res.data, groupTextHash(clean));
  } catch {
    return false;
  }
}
