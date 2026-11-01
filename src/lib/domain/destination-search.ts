import { z } from "zod";
import type { ActionError } from "./result";
import { Month } from "./trip";

/**
 * Find destinations by trip purpose. Spec: docs/specs/find-destinations.md sections 4, 8 and 9; flight or drive:
 * docs/specs/find-destinations-drive.md.
 */

/** Longest `name`/`reason` and list sizes. Mirrored by the CHECK constraints of migrations 20261106120031 and 20261107120032. */
export const MAX_IDEAS = 8;
export const MAX_CARDS_PER_ROUND = 5;
export const MAX_SEARCH_ROUNDS = 2;
export const SEARCHES_KEPT_PER_USER = 10;
export const REASON_MAX_CHARS = 160;
/** A saved list is reused for the same input for this long. */
export const SEARCH_CACHE_DAYS = 30;

export const TravelMode = z.enum(["flight", "drive"]);
export type TravelMode = z.infer<typeof TravelMode>;

export const DestinationSearchInput = z
  .object({
    purposeId: z.string().uuid(),
    months: z.array(Month).max(3).default([]),
    groupId: z.string().uuid().nullable().default(null),
    travelMode: TravelMode.default("flight"), // an open old tab keeps working: no mode is a flight search
    origins: z.array(z.string().regex(/^[A-Z]{3}$/)).max(2).optional(), // absent = profile; empty = none
    maxFlightHours: z.number().min(1).max(15).multipleOf(0.5).nullable().optional(), // absent = purpose; null = none
    maxDriveHours: z.number().min(1).max(12).multipleOf(0.5).optional(), // drive only, required there
    homeGeoId: z.number().int().positive().optional(), // drive only; absent = the profile's home
    saveHome: z.boolean().default(false), // drive only: also save homeGeoId as the profile home
  })
  .superRefine((v, ctx) => {
    const bad = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (v.travelMode === "drive") {
      if (v.maxDriveHours === undefined) bad("maxDriveHours", "A drive search needs a limit");
      if (v.origins !== undefined) bad("origins", "A drive search has no airports");
      if (v.maxFlightHours !== undefined) bad("maxFlightHours", "A drive search has no flight limit");
    } else {
      if (v.maxDriveHours !== undefined) bad("maxDriveHours", "A flight search has no drive limit");
      if (v.homeGeoId !== undefined) bad("homeGeoId", "A flight search has no start place");
      if (v.saveHome) bad("saveHome", "A flight search does not save a home");
    }
  });
export type DestinationSearchInput = z.input<typeof DestinationSearchInput>;
export type DestinationSearchInputParsed = z.output<typeof DestinationSearchInput>;

/** Why a verified-away idea was dropped. Counted, never named (no place names in `drops`). */
export const DROP_REASONS = ["not_found", "duplicate", "too_far", "climate", "no_poi", "geocode_failed", "no_road", "drive_failed"] as const;
export type DropReason = (typeof DROP_REASONS)[number];
export const DropCounts = z.partialRecord(z.enum(DROP_REASONS), z.number().int().min(0));
export type DropCounts = z.infer<typeof DropCounts>;
/** Counts per round ("1", "2"). */
export const SearchDrops = z.object({ "1": DropCounts.optional(), "2": DropCounts.optional() });
export type SearchDrops = z.infer<typeof SearchDrops>;

const Checked = z.object({ source: z.enum(["geonames", "open_meteo", "osm"]), fetchedAt: z.string(), stale: z.boolean() });

export const MonthlyClimateSchema = z.object({
  month: z.number().int().min(1).max(12),
  tMaxC: z.number(),
  tMinC: z.number(),
  precipMm: z.number(),
  wetDays: z.number(),
  sunshineHours: z.number(),
});

export const SuggestionCard = z.object({
  id: z.string(),
  round: z.union([z.literal(1), z.literal(2)]),
  name: z.string().max(80),
  reason: z.string().max(REASON_MAX_CHARS).nullable(),
  kind: z.enum(["city", "region"]),
  geoId: z.number().int(),
  placeName: z.string(),
  countryCode: z.string().length(2),
  admin1: z.string().nullable(),
  place: Checked,
  flight: z.object({ origin: z.string(), gateway: z.string(), minutes: z.number().int() }).nullable(),
  nearAirport: z.boolean(),
  /**
   * The verified road drive (drive searches only; such cards have `flight: null`). `.optional()` is required: saved
   * flight cards do not have the key, and a failed parse would silently empty every saved list (`rowToSearch`).
   */
  drive: z
    .object({
      min: z.number().int(),
      km: z.number(),
      source: z.literal("openrouteservice"),
      fetchedAt: z.string(),
      stale: z.boolean(),
    })
    .nullable()
    .optional(),
  climate: z
    .discriminatedUnion("status", [
      z.object({
        status: z.literal("ok"),
        months: z.array(MonthlyClimateSchema),
        period: z.object({ from: z.number(), to: z.number() }),
        ...Checked.shape,
      }),
      z.object({ status: z.literal("not_checked") }),
    ])
    .nullable(), // null = no month chosen
  pois: z
    .array(
      z.discriminatedUnion("status", [
        z.object({ status: z.literal("ok"), interest: z.string(), count: z.number().int(), radiusKm: z.number(), ...Checked.shape }),
        z.object({ status: z.literal("not_checked"), interest: z.string() }),
      ]),
    )
    .max(2),
});
export type SuggestionCard = z.infer<typeof SuggestionCard>;
export const SuggestionCards = z.array(SuggestionCard);

export type DestinationSearchStatus = "running" | "done" | "failed";

/** One saved list as the API returns it (camelCase of the table row, without `input`/`input_hash`). */
export type DestinationSearch = {
  id: string;
  /** null = the purpose was deleted since; the list stays with `purposeName`. */
  purposeId: string | null;
  groupId: string | null;
  purposeName: string;
  locale: "de" | "en";
  months: number[];
  origins: string[];
  travelMode: TravelMode;
  /** The limit this search used; null = none (also when there were no airports, and in drive mode). */
  maxFlightHours: number | null;
  /** Drive mode: the limit in hours. Null in flight mode. */
  maxDriveHours: number | null;
  /** Drive mode: the start place (name only; the coordinates stay on the server). */
  homeName: string | null;
  /** Straight-line radius used by the flight filter, or the hint in drive mode; null = no filter. */
  radiusKm: number | null;
  status: DestinationSearchStatus;
  /** 1 or 2: how many LLM rounds this list has used. */
  rounds: 1 | 2;
  cards: SuggestionCard[];
  drops: SearchDrops;
  /** Set when status is "failed" (an ActionError code, e.g. ai_unavailable, places_unavailable). */
  error: ActionError | null;
  createdAt: string;
  updatedAt: string;
};

/** GET/POST body: the list plus what the page needs to decide on its buttons. */
export type DestinationSearchView = DestinationSearch & {
  /** Round 2 is still unused, the list is done, and AI is switched on. */
  canShowOthers: boolean;
  aiEnabled: boolean;
  /** POST only: the list was served from the saved lists, no AI call was made. */
  cached?: boolean;
};
