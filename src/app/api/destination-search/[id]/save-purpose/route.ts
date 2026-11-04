import { NextResponse } from "next/server";
import { saveSearchAsPurpose } from "@/lib/server/discover/save-purpose";
import { NO_STORE, STATUS } from "../../../trips/[id]/plan/respond";

/**
 * POST /api/destination-search/[id]/save-purpose { name } -> 200 { purposeId, name, created }
 * Saves the typed one-off purpose of a list as a trip purpose and links the list to it (spec 13.4). No LLM call.
 * Errors: { error, issues? } with the status of the code (unauthenticated 401, not_found 404, busy 409, conflict 409,
 * invalid 422, rate_limited 429, failed).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body: unknown = await request.json().catch(() => null);
  // A missing or malformed body goes through the same function: the session is checked before the shape.
  const res = await saveSearchAsPurpose(id, body ?? {});
  if (res.ok) return NextResponse.json(res.data, { headers: NO_STORE });
  return NextResponse.json(res.issues ? { error: res.error, issues: res.issues } : { error: res.error }, {
    status: STATUS[res.error],
    headers: NO_STORE,
  });
}
