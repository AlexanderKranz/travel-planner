import { runDestinationSearch } from "@/lib/server/discover/pipeline";
import { respond } from "./respond";

// Vercel Hobby with Fluid compute allows up to 300 s. One Haiku call (seconds) plus up to 45 s of verification.
export const maxDuration = 120;

/**
 * POST /api/destination-search { purposeId, months?, groupId?, origins?, maxFlightHours? } -> { search }
 * Returns the saved list when one exists for the same input (no AI call, works with AI off). The client abort
 * signal is deliberately NOT forwarded: the server finishes and saves the list even if the browser leaves
 * (the page then polls GET /api/destination-search/[id]).
 */
export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  // A missing or malformed body goes through the same pipeline: the session is checked before the shape, so anonymous
  // callers learn nothing about it, and signed-in callers get `invalid`.
  return respond(await runDestinationSearch(body ?? {}));
}
