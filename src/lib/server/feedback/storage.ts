import "server-only";
import { FEEDBACK_BUCKET } from "@/lib/domain/feedback";
import { createSupabaseAdminClient } from "../supabase/admin";

/**
 * Screenshot storage (private bucket, secret key only). Path: `<owner_id>/<feedback_id>.<ext>`.
 * Secret key on purpose: the bucket has no policies for anon or authenticated (spec D9).
 */

/** Removes every screenshot of one user (`<uid>/`). Storage objects do not cascade with the auth user. True = done. */
export async function removeFeedbackScreenshots(userId: string): Promise<boolean> {
  try {
    const bucket = createSupabaseAdminClient().storage.from(FEEDBACK_BUCKET);
    for (let round = 0; round < 50; round++) {
      const { data, error } = await bucket.list(userId, { limit: 100 });
      if (error) return false;
      if (!data || data.length === 0) return true;
      const { error: removeError } = await bucket.remove(data.map((o) => `${userId}/${o.name}`));
      if (removeError) return false;
    }
    return false;
  } catch {
    return false;
  }
}

/** Removes the listed object paths. True = done. */
export async function removeScreenshotPaths(paths: string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  try {
    const { error } = await createSupabaseAdminClient().storage.from(FEEDBACK_BUCKET).remove(paths);
    return !error;
  } catch {
    return false;
  }
}
