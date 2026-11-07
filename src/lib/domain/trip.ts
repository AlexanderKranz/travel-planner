import { z } from "zod";
import { IsoDate, optionalText } from "./common";
import { CompositionEntry, MAX_ENTRIES_PER_GROUP, type StatedAge } from "./group";
import { GROUP_TEXT_MAX, type GroupParse } from "./group-text";
import type { PurposeTags } from "./plan";
import { HomeAirports } from "./profile";
import { TRIP_PURPOSE_TEXT_MAX } from "./purpose";
import type { Access, Person } from "./sharing";

export const MAX_TRIP_DAYS = 60;
export const MAX_TRIPS_PER_USER = 30;
export const DEFAULT_RADIUS_KM = { city: 15, region: 40 } as const;

export const Month = z.number().int().min(1).max(12);

export const TripTimingInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("date"), startDate: IsoDate }),
  z.object({
    kind: z.literal("months"),
    months: z
      .array(Month)
      .min(1)
      .max(12)
      .transform((m) => [...new Set(m)].sort((a, b) => a - b)),
  }),
  z.object({ kind: z.literal("none") }),
]);

const GeoDestinationFields = {
  geoId: z.number().int().positive().max(2147483647),
  name: optionalText(120), // custom display name; default = place name
  radiusKm: z.number().int().min(1).max(200).optional(),
};

/** The client sends only the geocoding id; the server resolves coordinates via getPlaceById (cached). */
export const DestinationInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("city"), ...GeoDestinationFields }),
  z.object({ kind: z.literal("region"), ...GeoDestinationFields }),
  z.object({
    kind: z.literal("freetext"),
    name: z.string().trim().min(1).max(120),
    countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  }),
]);

export const TripInput = z
  .object({
    title: optionalText(120),
    destination: DestinationInput,
    lengthDays: z.number().int().min(1).max(MAX_TRIP_DAYS),
    timing: TripTimingInput.default({ kind: "none" }),
    groupId: z.string().uuid().nullable().default(null),
    /** One-off group for this trip only (free text); mutually exclusive with `groupId`. */
    groupText: optionalText(GROUP_TEXT_MAX),
    /** The user's corrected structure for `groupText`; wins over the Haiku parse. Empty = none. */
    groupStructure: z.array(CompositionEntry).max(MAX_ENTRIES_PER_GROUP).default([]),
    purposeId: z.string().uuid().nullable().default(null),
    /** One-off purpose for this trip only (free text); mutually exclusive with `purposeId`. */
    purposeText: optionalText(TRIP_PURPOSE_TEXT_MAX),
    wantsFlights: z.boolean().default(false),
    originAirports: HomeAirports.default([]), // isKnownIata checked server-side
    notes: optionalText(2000),
    /** Set when the trip was made from a destination suggestion; absent on an update = keep the stored link. */
    destinationSearchId: z.string().uuid().nullable().optional(),
  })
  .superRefine((trip, ctx) => {
    if (trip.groupId && (trip.groupText || trip.groupStructure.length > 0)) {
      ctx.addIssue({ code: "custom", path: ["groupText"], message: "Either a saved group or a one-off group" });
    }
    if (trip.purposeId && trip.purposeText) {
      ctx.addIssue({ code: "custom", path: ["purposeText"], message: "Either a saved purpose or a one-off purpose" });
    }
    if (trip.groupStructure.length > 0 && !trip.groupText) {
      ctx.addIssue({ code: "custom", path: ["groupStructure"], message: "Structure needs a description" });
    }
  });
export type TripInput = z.input<typeof TripInput>;
export type TripInputParsed = z.output<typeof TripInput>;

export type TripTiming =
  | { kind: "date"; startDate: string }
  | { kind: "months"; months: number[] }
  | { kind: "none" };

export type Destination =
  | {
      kind: "city" | "region";
      name: string;
      placeName: string;
      geoId: number;
      countryCode: string | null;
      admin1: string | null;
      lat: number;
      lon: number;
      timezone: string | null;
      radiusKm: number; // default applied
    }
  | { kind: "freetext"; name: string; countryCode: string | null };

/** Entry of the one-off group's corrected structure, as stored in trips.group_structure. */
export type TripGroupEntry = {
  count: number;
  label?: string;
  notes?: string;
  age?: StatedAge;
  /** Date a numeric age was entered (server-set), so it keeps advancing to the travel date. */
  ageAsOf?: string;
};

export type Trip = {
  id: string;
  /** Who owns the trip (spec sharing 3.1). */
  ownerId: string;
  /** The viewer's access: owner, or the level of the viewer's share. */
  access: Access;
  title?: string;
  destination: Destination;
  lengthDays: number;
  timing: TripTiming;
  groupId: string | null;
  /** One-off group text (no saved group). */
  groupText?: string;
  /** User-corrected structure of `groupText` (empty = none). */
  groupStructure?: TripGroupEntry[];
  /** Haiku parse of `groupText`; set only when it belongs to the current text, else undefined. */
  groupParse?: GroupParse;
  purposeId: string | null;
  /** One-off purpose text (no saved purpose). */
  purposeText?: string;
  /** Haiku tags of `purposeText`; set only when they belong to the current text, else undefined. */
  purposeTags?: PurposeTags;
  wantsFlights: boolean;
  originAirports: string[]; // as stored; empty = use profile
  notes?: string;
  /** The saved suggestion list this trip was made from (find-destinations); the link "Back to suggestions". */
  destinationSearchId?: string;
  createdAt: string;
  updatedAt: string;
};

export type TripSummary = Pick<
  Trip,
  "id" | "title" | "destination" | "lengthDays" | "timing" | "updatedAt"
> & {
  groupName: string | null;
  purposeName: string | null;
  /** The viewer's access (own trips: "owner"). */
  access: Access;
  /** Who shared the trip with the viewer; null for own trips. Set by `listSharedWithMe`. */
  sharedBy: Person | null;
  /** Own trips: number of people it is shared with (0 when none). Incoming trips: 0. */
  shareCount: number;
};
