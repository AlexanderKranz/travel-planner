// Pure builders for the demo account's finished example trip. No I/O, no LLM, no network.
// Imported by scripts/demo/reset.mjs (Node strips the types) and unit-tested in seed.test.ts.
// Keep this file free of `@/` imports and of non-erasable TypeScript (enums, parameter properties).

export type ExamplePlanFile = {
  model: string;
  inputHash: string;
  plan: {
    header: { title: string; basis: { tripUpdatedAt: string; groupUpdatedAt: string | null; purposeUpdatedAt: string | null } } & Record<string, unknown>;
  } & Record<string, unknown>;
  input: Record<string, unknown>;
};

export type ExampleTripRow = Record<string, unknown>;

/** Same trip as the golf eval fixture (evals/fixtures/golftrip-costa-del-sol.json): the recorded plan fits it. */
export const EXAMPLE_TRIP = {
  title: "Golf an der Costa del Sol",
  dest_kind: "region",
  dest_name: "Costa del Sol",
  dest_geo_id: 2514169,
  dest_place_name: "Marbella",
  dest_country_code: "ES",
  dest_admin1: "Andalusien",
  dest_lat: 36.51543,
  dest_lon: -4.88583,
  dest_timezone: "Europe/Madrid",
  dest_radius_km: 40,
  length_days: 5,
  start_date: "2038-03-13",
  months: [] as number[],
  wants_flights: true,
  origin_airports: ["FRA"],
  notes: "Beispielreise mit fertigem Plan (Demo).",
};

export const EXAMPLE_GROUP = {
  name: "Golf-Freunde",
  description: "Ich und ein Freund, ähnliches Alter. Beide spielen Golf, einer mit Handicap 18.",
  notes: null as string | null,
  trait_keys: [] as string[],
};

type ItemRow = {
  category: "flight" | "stay" | "car" | "transport" | "activity" | "food" | "other";
  title: string;
  status: "option" | "planned" | "booked" | "rejected";
  price_cents: number | null;
  price_basis: "total" | "per_person";
  persons: number | null;
  currency: string;
  day: number | null;
  start_time: string | null;
  end_time: string | null;
  notes: string | null;
};

/**
 * The first three match the golf fixture items the recorded plan was generated with (booked flight with times,
 * booked dinner, hotel option), so the plan's fixed rows and the item list agree. The rest only fill the cost summary.
 */
export const EXAMPLE_ITEMS: ItemRow[] = [
  { category: "flight", title: "LH 1150 FRA → AGP", status: "booked", price_cents: 21800, price_basis: "per_person", persons: 2, currency: "EUR", day: 1, start_time: "13:00", end_time: "16:00", notes: null },
  { category: "flight", title: "LH 1151 AGP → FRA", status: "booked", price_cents: 19800, price_basis: "per_person", persons: 2, currency: "EUR", day: 5, start_time: "17:10", end_time: "20:40", notes: null },
  { category: "food", title: "Tisch im Restaurant am Hafen", status: "booked", price_cents: null, price_basis: "total", persons: null, currency: "EUR", day: 3, start_time: "20:00", end_time: "22:00", notes: null },
  { category: "stay", title: "Hotel Marbella", status: "option", price_cents: 72000, price_basis: "total", persons: null, currency: "EUR", day: 1, start_time: "18:00", end_time: null, notes: "4 Nächte, Einzelzimmer" },
  { category: "car", title: "Mietwagen Malaga", status: "planned", price_cents: 24000, price_basis: "total", persons: null, currency: "EUR", day: 1, start_time: null, end_time: null, notes: null },
  { category: "activity", title: "Greenfees (5 Runden)", status: "planned", price_cents: 9500, price_basis: "per_person", persons: 2, currency: "EUR", day: null, start_time: null, end_time: null, notes: null },
];

export function buildExampleTrip(ids: { ownerId: string; groupId: string; purposeId: string }): ExampleTripRow {
  return { ...EXAMPLE_TRIP, owner_id: ids.ownerId, group_id: ids.groupId, purpose_id: ids.purposeId };
}

export function buildExampleItems(ids: { ownerId: string; tripId: string }): Record<string, unknown>[] {
  return EXAMPLE_ITEMS.map((i) => ({ ...i, owner_id: ids.ownerId, trip_id: ids.tripId }));
}

/**
 * The plan_versions row (kind "generate", version_no is assigned by the DB trigger). The header is re-pointed at the
 * real rows so the app does not show "plan is outdated": the title follows the trip and the basis timestamps are
 * the rows' own updated_at values.
 */
export function buildExampleVersion(
  example: ExamplePlanFile,
  ids: { ownerId: string; planId: string },
  basis: { tripUpdatedAt: string; groupUpdatedAt: string; purposeUpdatedAt: string },
): Record<string, unknown> {
  const plan = {
    ...example.plan,
    header: { ...example.plan.header, title: EXAMPLE_TRIP.title, basis },
  };
  return {
    owner_id: ids.ownerId,
    plan_id: ids.planId,
    kind: "generate",
    plan,
    input: example.input,
    input_hash: example.inputHash,
    feedback: null,
    changed_days: [],
    model: example.model,
    cost_micro_usd: 0, // seeded from a recording: no real spend, nothing written to ai_usage
  };
}
