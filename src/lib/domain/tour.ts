import { z } from "zod";
import { HHMM, IsoDate } from "./common";

/**
 * City tours (docs/specs/city-tour.md, ADR 0012). Pure schemas and constants, no I/O.
 */

/** One place of a tour. Coordinates are always resolved by the server from a key it handed out (spec 3.1). */
export const TourPoint = z.object({
  key: z.string().min(1).max(40), // "osm:n123", "osm:w456", "geo:2761369" (GeoNames), "gfy:<place_id>"
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
export const ORS_PROFILE: Record<TourMode, string> = {
  foot: "foot-walking",
  wheelchair: "wheelchair",
  cycling: "cycling-regular",
  car: "driving-car",
};

/** Corridor around a leg in metres for sights near the route (spec 6 [T12]). */
export const CORRIDOR_M: Record<TourMode, number> = { foot: 150, wheelchair: 150, cycling: 300, car: 1000 };

/** Key of a per-leg override: the place pair `"<fromKey>><toKey>"` ([T7]). */
export const legKey = (from: string, to: string): string => `${from}>${to}`;

export const LegSetting = z.object({ mode: z.enum(TOUR_MODES), route: z.enum(ROUTE_OPTIONS) });
export type LegSetting = z.infer<typeof LegSetting>;

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export const TourInput = z
  .object({
    title: z.string().trim().max(120).optional(),
    city: TourPoint.optional(),
    places: z.array(TourPoint).min(2).max(MAX_TOUR_PLACES),
    start: TourPoint.optional(),
    end: z.union([z.literal("start"), TourPoint]).optional(), // absent = open end
    order: z.enum(["optimize", "keep"]).default("optimize"),
    mode: z.enum(TOUR_MODES).default("foot"),
    route: z.enum(ROUTE_OPTIONS).default("fastest"),
    legOverrides: z.record(z.string().max(81), LegSetting).optional(),
    date: IsoDate.optional(),
    startTime: HHMM.optional(),
    endBy: HHMM.optional(), // needs startTime
    minMin: z.number().int().min(15).max(1440).optional(),
    maxMin: z.number().int().min(15).max(1440).optional(),
    dwellDefaultMin: z.number().int().min(0).max(240).default(30),
  })
  .superRefine((v, ctx) => {
    const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (!routeAllowed(v.mode, v.route)) bad(["route"], "Route option not available for this mode");
    for (const [k, o] of Object.entries(v.legOverrides ?? {})) {
      if (!routeAllowed(o.mode, o.route)) bad(["legOverrides", k, "route"], "Route option not available for this mode");
    }
    if (v.minMin !== undefined && v.maxMin !== undefined && v.minMin > v.maxMin) bad(["minMin"], "minMin > maxMin");
    if (v.endBy !== undefined) {
      if (v.startTime === undefined) bad(["endBy"], "endBy needs startTime");
      else if (toMin(v.endBy) <= toMin(v.startTime)) bad(["endBy"], "endBy must be after startTime");
    }
    if (v.end === "start" && !v.start) bad(["end"], "A round trip needs a start");
    // Leg keys and override keys need distinct points. `end` may share the start key (a round trip written out).
    const keys = v.places.map((p) => p.key);
    if (new Set(keys).size !== keys.length) bad(["places"], "Duplicate place");
    const ends = [v.start?.key, typeof v.end === "object" ? v.end.key : undefined];
    if (ends.some((k) => k !== undefined && keys.includes(k))) bad(["places"], "A place equals the start or end");
  });
/** Parsed input (defaults applied). */
export type TourInput = z.output<typeof TourInput>;

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
