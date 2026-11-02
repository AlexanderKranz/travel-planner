import "server-only";
import { FeedbackKind, FeedbackStatus, type MyFeedbackItem } from "@/lib/domain/feedback";
import { z } from "zod";
import { getUserSession } from "../session";

const Row = z.object({
  ref: z.string(),
  kind: FeedbackKind,
  created_at: z.string(),
  status: FeedbackStatus,
  issue_url: z.string().nullable(),
});

/**
 * The signed-in user's own reports, newest first, at most 50. Runs on the user session, so RLS ("owner select")
 * decides what is returned. Empty when signed out or on a read error. `failed` shows as "received" (spec D13).
 */
export async function listMyFeedback(): Promise<MyFeedbackItem[]> {
  const session = await getUserSession();
  if (!session) return [];
  const { data, error } = await session.supabase
    .from("feedback")
    .select("ref, kind, created_at, status, issue_url")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data.flatMap((r): MyFeedbackItem[] => {
    const p = Row.safeParse(r);
    if (!p.success) return [];
    const published = p.data.status === "created" && p.data.issue_url !== null;
    return [{ ref: p.data.ref, kind: p.data.kind, createdAt: p.data.created_at, status: published ? "published" : "received", issueUrl: published ? p.data.issue_url : null }];
  });
}
