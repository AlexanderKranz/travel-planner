import { z } from "zod";
import { IsoDate, optionalText } from "./common";
import { IataCode } from "./flights";
import { Locale } from "./profile";
import { INTEREST_KEYS } from "./interests";

export const PLAN_SCHEMA_VERSION = 1;
export const MAX_PLAN_DAYS = 21; // [D5]
export const MAX_VERSIONS_KEPT = 30; // [D3]
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const OsmKey = z.string().regex(/^(node|way|relation)\/\d{1,15}$/);
export type OsmKey = z.infer<typeof OsmKey>;

export const ActivityKind = z.enum(["see", "do", "sport", "food", "rest", "travel", "shop", "free"]);
export type ActivityKind = z.infer<typeof ActivityKind>;

export const PlanActivity = z.object({
  at: HHMM.optional(), // local time at the destination
  until: HHMM.optional(),
  kind: ActivityKind,
  text: z.string().min(1).max(200), // AI prose; never prices, opening hours, flight numbers
  ref: OsmKey.optional(), // key into plan.places; only ids that were in the input
});
export type PlanActivity = z.infer<typeof PlanActivity>;

export const PlanStop = z.object({
  place: z.string().min(1).max(80), // "Dürnstein", "Marbella"
  from: HHMM.optional(), // time window, e.g. port call 07:00–12:00
  to: HHMM.optional(),
  fixed: z.boolean().optional(), // true = window copied from the user's trip notes
  acts: z.array(PlanActivity).max(12),
});
export type PlanStop = z.infer<typeof PlanStop>;

export const PlanDay = z.object({
  n: z.number().int().min(1).max(MAX_PLAN_DAYS), // 1-based day index
  date: IsoDate.nullable(), // set by code; null when the trip has no exact date
  title: z.string().min(1).max(80), // location/headline: "Wachau → Wien"
  stops: z.array(PlanStop).min(1).max(4),
  note: z.string().max(240).optional(),
  warn: z.string().max(240).optional(),
  best: z.boolean().optional(), // "best day" highlight; code keeps at most one
});
export type PlanDay = z.infer<typeof PlanDay>;

export const PlanNote = z.object({ kind: z.enum(["tip", "warning"]), text: z.string().min(1).max(240) });
export type PlanNote = z.infer<typeof PlanNote>;
export const OpenItem = z.object({
  text: z.string().min(1).max(160),
  day: z.number().int().min(1).max(MAX_PLAN_DAYS).optional(),
});
export type OpenItem = z.infer<typeof OpenItem>;

/** Fact-derived place, copied by code from TripFacts. Rendered with "© OpenStreetMap" + check date. */
export const PlanPlace = z.object({
  name: z.string(),
  category: z.string(), // "leisure=golf_course"
  lat: z.number(),
  lon: z.number(),
  distanceKm: z.number(), // from the destination anchor (straight line)
  airportKm: z.number().optional(), // straight line to the gateway airport
  osmUrl: z.string().url(),
  wikipedia: z.string().optional(),
  website: z.string().url().optional(),
  source: z.literal("osm"),
  fetchedAt: z.string(),
});
export type PlanPlace = z.infer<typeof PlanPlace>;

/** Computed from resolved ages; no names, no ages stored. */
export const GroupSummary = z.object({
  total: z.number().int(),
  adults: z.number().int(),
  children: z.number().int(), // 3–17
  toddlers: z.number().int(), // 0–2
  unknown: z.number().int(), // no age
});
export type GroupSummary = z.infer<typeof GroupSummary>;

export const PlanHeader = z.object({
  title: z.string().max(120), // trip title or fallback at generation time
  destination: z.string().max(120),
  timing: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("date"), startDate: IsoDate, endDate: IsoDate }),
    z.object({ kind: z.literal("months"), months: z.array(z.number().int().min(1).max(12)) }),
    z.object({ kind: z.literal("none") }),
  ]),
  lengthDays: z.number().int().min(1).max(MAX_PLAN_DAYS),
  group: GroupSummary.nullable(),
  purposeName: z.string().max(80).nullable(),
  generatedAt: z.string(), // ISO instant of the AI call that produced the days
  model: z.string(),
  basis: z.object({
    // "outdated" detection (spec 5.5)
    tripUpdatedAt: z.string(),
    groupUpdatedAt: z.string().nullable(),
    purposeUpdatedAt: z.string().nullable(),
  }),
});
export type PlanHeader = z.infer<typeof PlanHeader>;

/** Facts as sent to the LLM, kept for the plan view, share page and PDF (phase 5). */
export const PlanFactsDigest = z.object({
  climate: z
    .object({
      months: z.array(
        z.object({
          month: z.number(),
          tMaxC: z.number(),
          tMinC: z.number(),
          wetDays: z.number(),
          sunshineHours: z.number(),
        }),
      ),
      period: z.object({ from: z.number(), to: z.number() }),
      fetchedAt: z.string(),
    })
    .optional(),
  daylight: z
    .object({
      timezone: z.string(),
      days: z.array(z.object({ date: IsoDate, sunrise: HHMM.nullable(), dusk: HHMM.nullable() })),
    })
    .optional(), // local times, computed (suncalc)
  airports: z.array(z.object({ iata: z.string(), name: z.string(), km: z.number() })).optional(),
  placesFetchedAt: z.string().optional(),
});
export type PlanFactsDigest = z.infer<typeof PlanFactsDigest>;

export const PlanFlightLeg = z.object({
  dir: z.enum(["out", "back"]),
  from: IataCode,
  to: IataCode,
  number: z.string().max(10),
  airline: z.string().max(60).nullable(),
  dep: HHMM,
  arr: HHMM,
  arrDayOffset: z.union([z.literal(0), z.literal(1)]),
  blockMin: z.number().int().min(0).max(1440),
  date: IsoDate,
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  tooLong: z.literal(true).optional(),
});
export const PlanFlights = z.object({
  basis: z.enum(["trip_dates", "sample_week"]),
  outDate: IsoDate,
  backDate: IsoDate,
  mode: z.object({ out: z.enum(["schedule", "proxy"]), back: z.enum(["schedule", "proxy"]) }),
  pairs: z
    .array(
      z.object({
        from: IataCode,
        to: IataCode,
        status: z.enum(["found", "none", "not_published", "not_checked"]),
        perDay: z.number().optional(),
      }),
    )
    .max(4),
  legs: z.array(PlanFlightLeg).max(12),
  maxBlockMin: z.number().int().nullable(),
  source: z.literal("aerodatabox"),
  fetchedAt: z.string(),
});
export type PlanFlights = z.infer<typeof PlanFlights>;

export const Plan = z.looseObject({
  // loose: phase 4/5 sections survive older code
  v: z.literal(1),
  locale: Locale,
  header: PlanHeader,
  summary: z.string().max(600),
  days: z.array(PlanDay).min(1).max(MAX_PLAN_DAYS),
  notes: z.array(PlanNote).max(10),
  openItems: z.array(OpenItem).max(12),
  packing: z.array(z.string().min(1).max(80)).max(15),
  places: z.record(OsmKey, PlanPlace), // only places referenced by an activity
  facts: PlanFactsDigest,
  // Reserved, not produced in phase 3. Phase 4: verified routes. Phase 5: items with status/cost + cost summary.
  flights: PlanFlights.optional(), // phase 4: code snapshot, never LLM output
  // Never written: items live in `trip_items`, costs are computed in code.
  items: z.unknown().optional(),
  costs: z.unknown().optional(),
});
export type Plan = z.infer<typeof Plan>;

// --- Feedback, edits, version metadata (spec 2.1) ---

export const PLAN_CHIPS = ["more_rest", "more_active", "less_travel", "kid_friendly", "rainy_day", "redo_day"] as const;
export type PlanChip = (typeof PLAN_CHIPS)[number];
export const DayNo = z.number().int().min(1).max(MAX_PLAN_DAYS);

export const PlanFeedback = z
  .object({
    chips: z.array(z.enum(PLAN_CHIPS)).max(4).default([]),
    days: z.array(DayNo).max(7).default([]), // scope; empty = the model decides (redo_day requires >= 1)
    text: optionalText(500), // free text, user's language
  })
  .refine((f) => f.chips.length > 0 || !!f.text, { message: "empty" })
  .refine((f) => !f.chips.includes("redo_day") || f.days.length > 0, { path: ["days"], message: "day required" });
export type PlanFeedback = z.infer<typeof PlanFeedback>;
export type PlanFeedbackInput = z.input<typeof PlanFeedback>;

/** Code-only edits, no LLM [D8]. */
export const PlanEdit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("swap_days"), a: DayNo, b: DayNo }), // swaps title/stops/note/warn/best, keeps n/date
  z.object({ kind: z.literal("set_best"), n: DayNo.nullable() }),
]);
export type PlanEdit = z.infer<typeof PlanEdit>;

export type PlanVersionKind = "generate" | "patch" | "edit" | "restore";
export type PlanVersionMeta = {
  versionNo: number;
  kind: PlanVersionKind;
  createdAt: string;
  feedback: PlanFeedback | PlanEdit | null;
  restoredFrom: number | null;
  changedDays: number[];
  model: string | null;
};
export type BudgetStatus = { spentMicroUsd: number; capMicroUsd: number; resetsAt: string /* next Berlin midnight */ };
export type PlanState = {
  tripId: string;
  version: { meta: PlanVersionMeta; plan: Plan } | null; // requested (?v=) or latest
  isLatest: boolean;
  versions: PlanVersionMeta[]; // newest first
  busy: boolean; // busy_until > now()
  outdated: boolean; // header.basis differs from current trip/group/purpose
  canIterate: boolean; // latest && days.length === trip.lengthDays && same start date && aiEnabled
  aiEnabled: boolean;
  budget: BudgetStatus;
};

/** Spec 5.5. Soft banner only. */
export function isPlanOutdated(
  basis: PlanHeader["basis"],
  current: { tripUpdatedAt: string; groupUpdatedAt?: string | null; purposeUpdatedAt?: string | null },
): boolean {
  return (
    basis.tripUpdatedAt !== current.tripUpdatedAt ||
    basis.groupUpdatedAt !== (current.groupUpdatedAt ?? null) ||
    basis.purposeUpdatedAt !== (current.purposeUpdatedAt ?? null)
  );
}

// --- LLM output schemas (structured outputs, spec 2.2) ---
// No length or count refinements here (structured outputs ignore most of them); assemblePlan enforces limits.

const LlmAct = z.object({
  at: z.string().optional(),
  until: z.string().optional(),
  kind: ActivityKind,
  text: z.string(),
  ref: z.string().optional() /* "p12" */,
});
const LlmStop = z.object({
  place: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  fixed: z.boolean().optional(),
  acts: z.array(LlmAct),
});
export const LlmDay = z.object({
  n: z.number().int(),
  title: z.string(),
  stops: z.array(LlmStop),
  note: z.string().optional(),
  warn: z.string().optional(),
  best: z.boolean().optional(),
});
export type LlmDay = z.infer<typeof LlmDay>;
export const LlmPlan = z.object({
  summary: z.string(),
  days: z.array(LlmDay),
  notes: z.array(PlanNote.extend({ text: z.string() })),
  open: z.array(z.object({ text: z.string(), day: z.number().int().optional() })),
  packing: z.array(z.string()),
});
export type LlmPlan = z.infer<typeof LlmPlan>;
export const LlmPatch = z.object({
  reply: z.string(), // one sentence for the user
  days: z.array(LlmDay), // ONLY changed days, each a full replacement
  summary: z.string().optional(),
  notes: LlmPlan.shape.notes.optional(),
  open: LlmPlan.shape.open.optional(),
});
export type LlmPatch = z.infer<typeof LlmPatch>;
export const PurposeTags = z.object({
  v: z.literal(1),
  interests: z.array(z.enum(INTEREST_KEYS)), // mapped from free text + custom interests
  custom: z.array(z.string()), // interests with no key, short English
  pace: z.enum(["relaxed", "balanced", "packed"]).optional(),
  hard: z.array(z.string()), // must-haves, short English, one requirement each
  soft: z.array(z.string()), // preferences
  summary: z.string(), // <= 300 chars, English, anything else that matters
});
export type PurposeTags = z.infer<typeof PurposeTags>;
