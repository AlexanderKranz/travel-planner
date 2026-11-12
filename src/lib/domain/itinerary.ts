import { z } from "zod";
import { TripStop } from "./trip-stops";

/**
 * Contract between the itinerary extraction (parser, prefilter, Haiku) and the trip form
 * (docs/specs/itinerary-upload.md sections 3 and 4). Pure types, shared by browser and server.
 */

/** Per-stop warnings shown in the preview (section 3.5). */
export const ITINERARY_FLAGS = [
  "outside_trip",
  "no_trip_date",
  "year_guessed",
  "not_in_source",
  "from_image",
  "time_unclear",
] as const;
export type ItineraryFlag = (typeof ITINERARY_FLAGS)[number];

/** One extracted stop for the preview. `stop.day` may exceed the trip length (then `outside_trip` is set). */
export type ExtractedStop = {
  stop: TripStop;
  /** The date as printed or derived (ISO), when the source had one. */
  date?: string;
  flags: ItineraryFlag[];
};

/** The trip context as it is in the form right now (unsaved dates count, section 3.5). */
export const ItineraryContext = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  lengthDays: z.number().int().min(1),
});
export type ItineraryContext = z.infer<typeof ItineraryContext>;

export const ITINERARY_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_ITINERARY_IMAGES = 3;
/** Max base64 length of one downscaled image (2 MB of bytes, [D9]). */
export const MAX_ITINERARY_IMAGE_B64 = Math.ceil((2 * 1024 * 1024 * 4) / 3);
/**
 * Max base64 length of all images of one request together (3 MB of bytes). Vercel refuses request bodies over
 * 4.5 MB, so 3 x 2 MB cannot be sent at once; a scan splits this budget across its pages.
 */
export const MAX_ITINERARY_TOTAL_B64 = Math.ceil((3 * 1024 * 1024 * 4) / 3);
/** Cap of the prefiltered text (section 3.2). */
export const MAX_ITINERARY_TEXT = 8000;

/** What the browser sends when the parser could not read the document: prefiltered text, or downscaled images. */
export const ItineraryExtractInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(MAX_ITINERARY_TEXT) }),
  z.object({
    kind: z.literal("images"),
    images: z
      .array(z.object({ mediaType: z.enum(ITINERARY_IMAGE_TYPES), data: z.string().min(1).max(MAX_ITINERARY_IMAGE_B64) }))
      .min(1)
      .max(MAX_ITINERARY_IMAGES)
      .refine((imgs) => imgs.reduce((n, i) => n + i.data.length, 0) <= MAX_ITINERARY_TOTAL_B64, {
        message: "Images too large together",
      }),
  }),
]);
export type ItineraryExtractInput = z.infer<typeof ItineraryExtractInput>;

/** How the stops were read (event `itinerary.extracted`). */
export type ItineraryPath = "parser" | "text_ai" | "image_ai";

/** Reasons the frontend maps to message keys. */
export type ItineraryExtractError =
  | "forbidden" // no write access to the trip
  | "invalid" // payload failed validation
  | "ai_off" // AI disabled: parser path only
  | "demo" // demo users: parser only ([D9])
  | "rate_limited" // per-minute or per-day limit ([D9])
  | "budget" // AI budget would be exceeded
  | "no_stops" // nothing that looks like an itinerary
  | "failed"; // model or network error

export type ItineraryExtractResult =
  | { ok: true; path: ItineraryPath; stops: ExtractedStop[] }
  | { ok: false; error: ItineraryExtractError };

/** Result of the pure parser (browser and server). `usable` = at least 2 stops and each has a place or sea. */
export type ItineraryParseResult = { stops: ExtractedStop[]; usable: boolean };
