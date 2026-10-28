import "server-only";
import type { AiCtx } from "@/lib/domain/ai";
import type { TripPurpose } from "@/lib/domain/purpose";
import { purposeTagsHash } from "@/lib/plan/hash";
import { needsTags, tagPurpose } from "./ai/purpose-tags";
import { logEvent } from "./events";
import { savePurposeTags } from "./plan-store";

/** True when a Haiku call would add tags (none cached for the current content). */
export const wantsTags = (p: TripPurpose | null): p is TripPurpose => !!p && p.tags == null && needsTags(p);

/**
 * One Haiku call → tags saved on the purpose (cached by content hash). Returns the purpose with tags and the new
 * updatedAt, or the unchanged purpose when tagging failed (logged). Budget checks are the caller's.
 */
export async function tagAndSave(userId: string, purpose: TripPurpose, ctx: AiCtx): Promise<TripPurpose> {
  const res = await tagPurpose(purpose, ctx);
  if (!res.ok) {
    await logEvent({ event: "purpose.tag_failed", level: "warn", userId, props: { purposeId: purpose.id, reason: res.error } });
    return purpose;
  }
  const saved = await savePurposeTags(userId, purpose.id, res.data, purposeTagsHash(purpose));
  // The save moves purpose.updated_at (trigger); use the new value so a plan basis stays current.
  return { ...purpose, tags: res.data, updatedAt: saved?.updatedAt ?? purpose.updatedAt };
}
