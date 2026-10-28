import "server-only";
import type { AiCtx, AiResult } from "@/lib/domain/ai";
import type { PurposeTags } from "@/lib/domain/plan";
import type { TripPurpose } from "@/lib/domain/purpose";
import { notImplemented } from "@/lib/plan/not-implemented";

/** True when the purpose has text, constraints or custom interests. Hash comparison is the caller's. */
export function needsTags(p: TripPurpose): boolean {
  void p;
  return notImplemented("needsTags");
}

export async function tagPurpose(p: TripPurpose, ctx: AiCtx): Promise<AiResult<PurposeTags>> {
  void p;
  void ctx;
  return notImplemented("tagPurpose");
}
