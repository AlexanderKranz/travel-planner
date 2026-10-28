import type { FactsCtx, Trip, TripPurpose } from "@/lib/domain";

export type PanelProps = { trip: Trip; purpose: TripPurpose | null; ctx: FactsCtx };
