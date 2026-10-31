import { DestinationPictureBand } from "@/components/picture/destination-picture";
import type { FactsCtx, Trip } from "@/lib/domain";
import { getDestinationPicture } from "@/lib/server/facts";

/** Destination photo at the very top. Renders nothing for freetext destinations or when no licensed picture exists. */
export async function PicturePanel({ trip, ctx }: { trip: Trip; ctx: FactsCtx }) {
  const d = trip.destination;
  if (d.kind === "freetext") return null;
  const picture = await getDestinationPicture(trip, ctx);
  if (!picture) return null;
  return <DestinationPictureBand picture={picture} placeName={d.name} />;
}
