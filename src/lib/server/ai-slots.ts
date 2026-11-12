import "server-only";
import { z } from "zod";
import { createSupabaseAdminClient } from "./supabase/admin";

/**
 * Durable per-user AI call limits, atomic across server instances (migration 20261115120040).
 * `reserveAiCall` takes a slot only when the minute and day limits allow it; `pending` counts the other slots of
 * this user and task still running, so the budget check can reserve for them. After the call, `settleAiCall`;
 * if the call never happens, `releaseAiCall` gives the slot back.
 */
export type AiSlot = { ok: true; id: string; pending: number } | { ok: false; reason: "minute" | "day" };

const Reply = z.union([
  z.object({ ok: z.literal(true), id: z.string().uuid(), pending: z.number().int().min(0) }),
  z.object({ ok: z.literal(false), reason: z.enum(["minute", "day"]) }),
]);

/** Throws when the database cannot be read, so callers fail closed. */
export async function reserveAiCall(args: {
  userId: string;
  task: string;
  perMinute: number;
  perDay: number;
  dayStart: Date;
}): Promise<AiSlot> {
  const { data, error } = await createSupabaseAdminClient().rpc("ai_reserve_call", {
    p_user: args.userId,
    p_task: args.task,
    p_minute_limit: args.perMinute,
    p_day_limit: args.perDay,
    p_day_start: args.dayStart.toISOString(),
  });
  if (error) throw new Error("ai_reserve_call failed");
  return Reply.parse(data);
}

/** Best effort: an unsettled slot stops holding budget after 10 minutes anyway. */
export async function settleAiCall(id: string): Promise<void> {
  try {
    await createSupabaseAdminClient().rpc("ai_settle_call", { p_id: id });
  } catch {
    // ignored
  }
}

/** Best effort: a slot that is not released counts once against the limits. */
export async function releaseAiCall(id: string): Promise<void> {
  try {
    await createSupabaseAdminClient().rpc("ai_release_call", { p_id: id });
  } catch {
    // ignored
  }
}
