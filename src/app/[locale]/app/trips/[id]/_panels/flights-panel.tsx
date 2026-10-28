import { FlightsLoader } from "@/components/facts/flights-loader";
import type { PanelProps } from "./types";

/** Client loader; the schedule lookups run in /api/trips/[id]/flights, not during page render. */
export function FlightsPanelSection({ trip, ctx, adults }: PanelProps & { adults: number }) {
  return <FlightsLoader tripId={trip.id} locale={ctx.locale} adults={adults} />;
}
