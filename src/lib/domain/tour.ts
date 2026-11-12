import { z } from "zod";
import { HHMM, IsoDate } from "./common";

/**
 * City tours (docs/specs/city-tour.md, ADR 0012). Pure schemas and constants, no I/O.
 */

/** One place of a tour. Coordinates are always resolved by the server from a key it handed out (spec 3.1). */
/** Spec 3.1 said 40; Geoapify place ids are longer, so `gfy:<place_id>` needs more room. */
export const MAX_POINT_KEY = 160;

export const TourPoint = z.object({
  key: z.string().min(1).max(MAX_POINT_KEY), // "osm:n123", "osm:w456", "geo:2761369" (GeoNames), "gfy:<place_id>"
  name: z.string().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  source: z.enum(["osm", "geonames", "geoapify"]),
  cat: z.string().max(40).optional(), // OSM category for the icon, e.g. "place_of_worship"
  dwellMin: z.number().int().min(0).max(480).optional(), // absent = tour default
});
export type TourPoint = z.infer<typeof TourPoint>;

/** Places of one tour; plus an optional start and end = at most 12 points (the Held–Karp limit). */
export const MAX_TOUR_PLACES = 10;
export const MAX_TOUR_POINTS = MAX_TOUR_PLACES + 2;

export const TOUR_MODES = ["foot", "wheelchair", "cycling", "car"] as const;
export type TourMode = (typeof TOUR_MODES)[number];

export const ROUTE_OPTIONS = ["fastest", "shortest", "green", "quiet", "no_steps", "no_highways"] as const;
export type RouteOption = (typeof ROUTE_OPTIONS)[number];

/**
 * Route options per mode (spec 5.2). The single place to edit when the ORS spike shows that a profile rejects an
 * option ([T5] note): remove it here and the form, the schema refine and the server all follow.
 */
export const ROUTE_OPTIONS_BY_MODE: Record<TourMode, readonly RouteOption[]> = {
  foot: ["fastest", "shortest", "green", "quiet", "no_steps"],
  wheelchair: ["fastest", "shortest"],
  cycling: ["fastest", "shortest", "quiet"],
  car: ["fastest", "shortest", "no_highways"],
};

export function routeAllowed(mode: TourMode, route: RouteOption): boolean {
  return ROUTE_OPTIONS_BY_MODE[mode].includes(route);
}

/** ORS profile per mode (spec 5.1). */
export const ORS_PROFILE = {
  foot: "foot-walking",
  wheelchair: "wheelchair",
  cycling: "cycling-regular",
  car: "driving-car",
} as const satisfies Record<TourMode, string>;
export type OrsTourProfile = (typeof ORS_PROFILE)[TourMode];

/** Corridor around a leg in metres for sights near the route (spec 6 [T12]). */
export const CORRIDOR_M: Record<TourMode, number> = { foot: 150, wheelchair: 150, cycling: 300, car: 1000 };

/** Key of a per-leg override: the place pair `"<fromKey>><toKey>"` ([T7]). */
export const legKey = (from: string, to: string): string => `${from}>${to}`;

export const LegSetting = z.object({ mode: z.enum(TOUR_MODES), route: z.enum(ROUTE_OPTIONS) });
export type LegSetting = z.infer<typeof LegSetting>;

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Settings of a tour besides its points (spec 3.2); shared by `TourInput` and `TourDraft`. */
const tourSettings = {
  title: z.string().trim().max(120).optional(),
  order: z.enum(["optimize", "keep"]).default("optimize"),
  mode: z.enum(TOUR_MODES).default("foot"),
  route: z.enum(ROUTE_OPTIONS).default("fastest"),
  legOverrides: z.record(z.string().max(2 * MAX_POINT_KEY + 1), LegSetting).optional(),
  date: IsoDate.optional(),
  startTime: HHMM.optional(),
  endBy: HHMM.optional(), // needs startTime
  minMin: z.number().int().min(15).max(1440).optional(),
  maxMin: z.number().int().min(15).max(1440).optional(),
  dwellDefaultMin: z.number().int().min(0).max(240).default(30),
};

type RefineInput = {
  mode: TourMode;
  route: RouteOption;
  legOverrides?: Record<string, LegSetting>;
  minMin?: number;
  maxMin?: number;
  startTime?: string;
  endBy?: string;
  places: { key: string }[];
  start?: { key: string };
  end?: "start" | { key: string };
};

export const TourInput = z
  .object({
    ...tourSettings,
    city: TourPoint.optional(),
    places: z.array(TourPoint).min(2).max(MAX_TOUR_PLACES),
    start: TourPoint.optional(),
    end: z.union([z.literal("start"), TourPoint]).optional(), // absent = open end
  })
  .superRefine(refineTour);
/** Parsed input (defaults applied). */
export type TourInput = z.output<typeof TourInput>;

/** Max length of a signed point reference (`ref`, see `src/lib/server/tour/point-ref.ts`). */
export const MAX_POINT_REF = 2048;

/**
 * A point as the browser sends it (spec 3.1: the browser never supplies coordinates). `key` names the point; `ref`
 * is the signed reference the server handed out with a suggestion or search result. Without a `ref`, the key must
 * be a `geo:<GeoNames id>` (resolved by id), a point already stored in the tour, or a sight of its stored result.
 */
export const TourPointDraft = z.object({
  key: z.string().min(1).max(MAX_POINT_KEY),
  ref: z.string().min(1).max(MAX_POINT_REF).optional(),
  dwellMin: z.number().int().min(0).max(480).optional(),
});
export type TourPointDraft = z.infer<typeof TourPointDraft>;

/** What createTour / updateTour accept: `TourInput` with point drafts; the server resolves them to `TourPoint`s. */
export const TourDraft = z
  .object({
    ...tourSettings,
    city: TourPointDraft.optional(),
    places: z.array(TourPointDraft).min(2).max(MAX_TOUR_PLACES),
    start: TourPointDraft.optional(),
    end: z.union([z.literal("start"), TourPointDraft]).optional(),
  })
  .superRefine(refineTour);
/** Form value (defaults optional). */
export type TourDraft = z.input<typeof TourDraft>;
export type TourDraftParsed = z.output<typeof TourDraft>;

function refineTour(v: RefineInput, ctx: z.RefinementCtx): void {
  const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  if (!routeAllowed(v.mode, v.route)) bad(["route"], "Route option not available for this mode");
  for (const [k, o] of Object.entries(v.legOverrides ?? {})) {
    if (!routeAllowed(o.mode, o.route)) bad(["legOverrides", k, "route"], "Route option not available for this mode");
  }
  if (v.minMin !== undefined && v.maxMin !== undefined && v.minMin > v.maxMin) bad(["minMin"], "minMin > maxMin");
  if (v.endBy !== undefined) {
    if (v.startTime === undefined) bad(["endBy"], "endBy needs startTime");
    else if (toMin(v.endBy) <= toMin(v.startTime)) bad(["endBy"], "endBy must be after startTime");
    else if (v.minMin !== undefined && v.minMin > toMin(v.endBy) - toMin(v.startTime)) {
      bad(["minMin"], "minMin longer than startTime to endBy");
    }
  }
  if (v.end === "start" && !v.start) bad(["end"], "A round trip needs a start");
  // Leg keys and override keys need distinct points. `end` may share the start key (a round trip written out).
  const keys = v.places.map((p) => p.key);
  if (new Set(keys).size !== keys.length) bad(["places"], "Duplicate place");
  const ends = [v.start?.key, typeof v.end === "object" ? v.end.key : undefined];
  if (ends.some((k) => k !== undefined && keys.includes(k))) bad(["places"], "A place equals the start or end");
}

export const LEG_STATUS = ["ok", "no_route", "not_routable", "failed"] as const;
export type LegStatus = (typeof LEG_STATUS)[number];

export const TourLeg = z.object({
  from: z.string(),
  to: z.string(),
  mode: z.enum(TOUR_MODES),
  route: z.enum(ROUTE_OPTIONS),
  min: z.number().int().min(0).nullable(),
  km: z.number().min(0).nullable(),
  poly: z.string().max(20000).nullable(), // encoded polyline, precision 5
  s: z.enum(LEG_STATUS),
});
export type TourLeg = z.infer<typeof TourLeg>;

export const TourSight = z.object({
  key: z.string(),
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
  leg: z.number().int(),
  m: z.number().int(), // straight-line metres from the route
  cat: z.string(),
  url: z.string().optional(),
});
export type TourSight = z.infer<typeof TourSight>;

export const MAX_TOUR_SIGHTS = 8;
export const MAX_SIGHTS_PER_LEG = 3;

export const TOUR_FIT = ["none", "ok", "over", "under"] as const;
export type TourFit = (typeof TOUR_FIT)[number];

/** Snapshot written by the server only (spec 9.2 [T14]). */
export const TourResult = z.object({
  v: z.literal(1),
  order: z.array(z.string()), // point keys, start first; a round trip ends with the start key again
  legs: z.array(TourLeg),
  totalMin: z.number().int().nullable(),
  fit: z.enum(TOUR_FIT),
  sunset: z.string().optional(), // HH:MM local, only when the tour ends after it
  sights: z.array(TourSight).max(MAX_TOUR_SIGHTS),
  source: z.object({ ors: z.string(), osm: z.string().optional() }), // oldest fetchedAt ISO per provider
  stale: z.boolean().optional(),
});
export type TourResult = z.infer<typeof TourResult>;

/** Viewer's access to a tour: the owner, or read-only through a trip shared with the viewer (spec 9.3). */
export type TourAccess = "owner" | "read";

/** A stored tour as the UI gets it. `outdated`: the stored result belongs to another input (or there is none). */
export type Tour = {
  id: string;
  ownerId: string;
  access: TourAccess;
  title: string | null;
  input: TourInput;
  tripId: string | null;
  tripDay: number | null;
  result: TourResult | null;
  computedAt: string | null;
  outdated: boolean;
  createdAt: string;
  updatedAt: string;
};

/** List row. `city` and `placeCount` feed the default title (`tours.defaultTitle`) when `title` is null. */
export type TourSummary = {
  id: string;
  access: TourAccess;
  title: string | null;
  city: string | null;
  placeCount: number;
  mode: TourMode;
  tripId: string | null;
  tripDay: number | null;
  startTime: string | null;
  totalMin: number | null;
  computedAt: string | null;
  outdated: boolean;
  updatedAt: string;
};

/** A place the server offers for a tour (cached city place or search result), with its signed reference. */
export type TourSuggestion = {
  key: string;
  ref: string;
  name: string;
  lat: number;
  lon: number;
  source: TourPoint["source"];
  cat?: string;
  /** Search results only: second address line and metres from the search centre. */
  address?: string;
  distanceM?: number;
};

/** Tours per owner (spec 9.1 [T18]). */
export const MAX_TOURS_PER_USER = 50;
/** Computations per user and Berlin day, and per minute (spec 11 step 3 [T17]). */
export const TOUR_COMPUTES_PER_DAY = 20;
export const TOUR_COMPUTES_PER_MIN = 10;
