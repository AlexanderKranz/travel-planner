import { showOtherDestinations } from "@/lib/server/discover/pipeline";
import { respond } from "../../respond";

export const maxDuration = 120;

/**
 * POST /api/destination-search/[id]/more (no body) -> { search }: the one "Show others" round on the same list.
 * Appends up to 5 more cards (round 2). Not available twice, nor on a failed or running list.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return respond(await showOtherDestinations(id));
}
