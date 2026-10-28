"use server";

import type { CreatedShareLink, ShareLink } from "@/lib/domain/share";
import { fail, type ActionResult } from "@/lib/domain/result";

/** STUBS (phase 5 step 0). */
export async function listShareLinks(_tripId: string): Promise<ActionResult<ShareLink[]>> {
  return { ok: true, data: [] };
}
export async function createShareLink(
  _tripId: string,
  _input: unknown,
): Promise<ActionResult<CreatedShareLink>> {
  return fail("failed");
}
export async function revokeShareLink(_id: string): Promise<ActionResult> {
  return fail("failed");
}
