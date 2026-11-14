import { z } from "zod";
import { MAX_TOUR_POINTS } from "./tour";

/**
 * Stop info of a city tour (docs/specs/city-tour-stop-info.md section 4): one card per tour point, fetched by code
 * from Wikipedia, Wikidata, Commons and OpenStreetMap, stored in `city_tours.stop_info`.
 */
export const STOP_TEXT_MAX = 700;
export const QID = /^Q\d{1,12}$/;
export const STOP_INFO_LOCALES = ["de", "en"] as const;
export type StopInfoLocale = (typeof STOP_INFO_LOCALES)[number];

export const StopImage = z.object({
  url: z.string().url(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  licence: z.string().max(60),
  licenceUrl: z.string().url().optional(),
  artist: z.string().max(200).optional(),
  file: z.string().max(240),
});
export type StopImage = z.infer<typeof StopImage>;

/** How the inception year is worded (spec 3): buildings "Erbaut", stations/museums "Eröffnet", else "Seit". */
export const YEAR_KINDS = ["built", "opened", "since"] as const;

export const StopFacts = z.object({
  year: z.number().int().min(-5000).max(2100).optional(),
  yearKind: z.enum(YEAR_KINDS).optional(),
  architects: z.array(z.string().max(80)).max(2).optional(),
  heritage: z.string().max(120).optional(),
  website: z.string().url().max(300).optional(),
  websiteFrom: z.enum(["osm", "wikidata"]).optional(),
  openingHours: z.string().max(255).optional(),
});
export type StopFacts = z.infer<typeof StopFacts>;

export const StopInfo = z.object({
  key: z.string().min(1).max(160),
  status: z.enum(["ok", "none"]),
  checkedAt: z.string(),
  /** When this entry was built (the 30-day refresh counts from here; checkedAt may be older, from cached answers). */
  storedAt: z.string().optional(),
  qid: z.string().regex(QID).optional(),
  lang: z.enum(STOP_INFO_LOCALES).optional(),
  title: z.string().max(200).optional(),
  text: z.string().max(STOP_TEXT_MAX).optional(),
  clipped: z.boolean().optional(),
  image: StopImage.optional(),
  facts: StopFacts.optional(),
});
export type StopInfo = z.infer<typeof StopInfo>;

export const TourStopInfo = z.object({
  v: z.literal(1),
  locale: z.enum(STOP_INFO_LOCALES),
  stops: z.array(StopInfo).max(MAX_TOUR_POINTS),
});
export type TourStopInfo = z.infer<typeof TourStopInfo>;

/** Entries older than this are fetched again on their next expand (spec 5). */
export const STOP_INFO_REFRESH_DAYS = 30;

/** What a viewer gets: the stored entries for the tour's current points, and whether new fetches are blocked. */
export type StopInfoView = {
  locale: StopInfoLocale;
  stops: StopInfo[];
  /** Keys that could have info but have no entry (unfinished batch or nothing fetched yet). */
  pending: string[];
  /** A daily limit is used up: only stored and cached info is shown (spec 12). */
  limited: boolean;
};
