import { z } from "zod";
import { IsoDate, optionalText } from "./common";
import { HomeAirports } from "./profile";

export const MAX_TRIP_DAYS = 60;
export const MAX_TRIPS_PER_USER = 100;
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

export const TripInput = z.object({
  title: optionalText(120),
  destination: DestinationInput,
  lengthDays: z.number().int().min(1).max(MAX_TRIP_DAYS),
  timing: TripTimingInput.default({ kind: "none" }),
  groupId: z.string().uuid().nullable().default(null),
  purposeId: z.string().uuid().nullable().default(null),
  wantsFlights: z.boolean().default(true),
  originAirports: HomeAirports.default([]), // isKnownIata checked server-side
  notes: optionalText(2000),
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

export type Trip = {
  id: string;
  title?: string;
  destination: Destination;
  lengthDays: number;
  timing: TripTiming;
  groupId: string | null;
  purposeId: string | null;
  wantsFlights: boolean;
  originAirports: string[]; // as stored; empty = use profile
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type TripSummary = Pick<
  Trip,
  "id" | "title" | "destination" | "lengthDays" | "timing" | "updatedAt"
> & {
  groupName: string | null;
  purposeName: string | null;
};
