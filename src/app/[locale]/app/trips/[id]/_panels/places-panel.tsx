import { PlacesLoader } from "@/components/facts/places-loader";
import type { PanelProps } from "./types";

/** Never blocks the page on Overpass: the client component fetches /api/trips/[id]/places itself. */
export function PlacesPanel({ trip, ctx }: PanelProps) {
  return <PlacesLoader tripId={trip.id} locale={ctx.locale} />;
}
