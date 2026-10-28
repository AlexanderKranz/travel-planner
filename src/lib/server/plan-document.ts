import "server-only";
import type { PlanDocument } from "@/lib/domain/share";
import golf from "./__fixtures__/plan-document-golf.json";

/** STUB (phase 5 step 0): returns the golf fixture. Real: RLS session reads. */
export async function getOwnerPlanDocument(_tripId: string): Promise<PlanDocument | null> {
  return golf as unknown as PlanDocument;
}

/** STUB: real version uses the admin client with explicit columns; every failure -> null (one 404). */
export async function getSharedPlanDocument(
  _token: string,
  _via: "page" | "pdf",
): Promise<PlanDocument | null> {
  return golf as unknown as PlanDocument;
}
