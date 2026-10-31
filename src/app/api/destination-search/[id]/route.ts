import { getDestinationSearch } from "@/lib/server/discover/pipeline";
import { respond } from "../respond";

export const maxDuration = 120;

/** GET /api/destination-search/[id] -> { search } (login required, RLS). Polled while `status` is "running". */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return respond(await getDestinationSearch(id));
}
