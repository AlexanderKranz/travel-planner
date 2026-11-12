import type { InterestKey } from "./interests";
import type { FlightsFacts } from "./flights";
import type { Locale } from "./profile";
import type { ActivityGroup, ActivityType } from "@/lib/facts/activity-types";
import type { ActivityPlace } from "@/lib/facts/activity-places";
import type { Cafe, Restaurant } from "@/lib/facts/cuisine";

export type SourceId = "open_meteo" | "geonames" | "osm" | "wikivoyage" | "wikipedia" | "wikimedia" | "rest_countries" | "suncalc" | "aerodatabox" | "openrouteservice" | "ourairports";

export type Fact<T> =
  | { status: "ok"; data: T; source: SourceId; sourceUrl?: string;
      fetchedAt: string;   // ISO timestamp; for computed facts = computation time; for static data = dataset date
      stale: boolean }
  | { status: "unavailable"; reason: "no_location" | "no_country" | "not_found" | "provider_error" | "no_origin" | "no_dates" | "disabled"; source?: SourceId };

export type MonthlyClimate = {
  month: number;          // 1..12
  tMaxC: number; tMinC: number;
  precipMm: number;       // mean monthly total
  wetDays: number;        // mean days with >= 1 mm
  sunshineHours: number;  // mean hours per day
};
export type WeatherFacts = {
  months: MonthlyClimate[];           // always 12
  selectedMonths: number[];           // empty = overview
  period: { from: number; to: number };
};

export type DaylightDay = {
  date: string;                        // YYYY-MM-DD
  sunrise: string | null; sunset: string | null; dusk: string | null;   // UTC ISO instants
  daylightMinutes: number;
  polar?: "day" | "night";
};
export type DaylightFacts = { timezone: string; basis: "trip_dates" | "mid_month"; days: DaylightDay[] };

export type CountryFacts = {
  code: string;
  nameEn: string;
  capital: string[];
  currencies: { code: string; symbol?: string }[];
  languages: { code: string; nameEn: string }[];   // ISO 639-3 as delivered
  callingCodes: string[];                           // "+34"
  drivingSide: "left" | "right";
  timezone: { iana: string | null; utcOffsets: string[]; countryZones: string[] };  // offsets on reference dates, e.g. "+01:00"
  plugs: null;                                      // phase 2: always null [D10]
};

export type DestinationSummary = {
  title: string;
  /** Intro text, paragraphs joined by a blank line ("\n\n"). */
  extract: string;
  /** The same text split into paragraphs (render one <p> each). Absent in entries cached before v2. */
  paragraphs?: string[];
  url: string;
  lang: string;
};

export type InterestOrGeneral = InterestKey | "general";
export type PlaceCandidate = {
  osmType: "node" | "way" | "relation";
  osmId: number;
  name: string;
  names: Partial<Record<"de" | "en", string>>;   // from name:de / name:en
  category: string;                               // matched tag, e.g. "leisure=golf_course"
  lat: number; lon: number;
  distanceKm: number;                             // from the destination anchor, 1 decimal
  wikidata?: string;
  wikipedia?: string;                             // "de:Passauer Dom"
  website?: string;
  osmUrl: string;                                 // https://www.openstreetmap.org/{type}/{id}
  openAir?: true;                                 // bath category and `isOpenAirBath` (name, note, indoor/covered tags); issue #142
};
export type PlaceGroup =
  | { interest: InterestOrGeneral; status: "ok"; candidates: PlaceCandidate[]; fetchedAt: string; stale: boolean }
  | { interest: InterestOrGeneral; status: "empty"; fetchedAt: string; stale: boolean }
  | { interest: InterestOrGeneral; status: "no_source" }
  | { interest: InterestOrGeneral; status: "error" };
export type PlacesFacts = { radiusKm: number; groups: PlaceGroup[]; customInterests: string[] };

/**
 * Outcome of one activity-group or restaurant lookup (activities spec section 5): `skipped` = not looked up
 * (free-text destination, cache-only run that missed), never reported as empty.
 */
export type LookupStatus = "ok" | "empty" | "error" | "skipped";
/** `truncated`: the source answer hit its cap (status stays ok); `reason` explains a `skipped` lookup. */
type LookupMeta = { fetchedAt?: string; truncated?: boolean; reason?: "no_location" | "cache_only" };
/**
 * Per-type outcome of a group lookup: a lookup status, `cut` = the answer hit its cap without this type, or
 * `unrequested` = no wish asked for the type and its source part was not fetched (never pending, never "nothing found").
 */
export type ActivityTypeStatus = LookupStatus | "cut" | "unrequested";
/**
 * `typeStatus` (Addendum 3, per-source lookups): what each type of the group really got. `partial`: a source part
 * failed or was skipped; the places are the other part's and the group is not complete. Both absent in lookups built
 * before Addendum 3: the per-type status is then derived from the group status (`lookupTypeStatus`).
 */
export type ActivityGroupLookup = {
  group: ActivityGroup;
  status: LookupStatus;
  places: ActivityPlace[];
  typeStatus?: Partial<Record<ActivityType, ActivityTypeStatus>>;
  partial?: true;
} & LookupMeta;
export type RestaurantLookup = { status: LookupStatus; restaurants: Restaurant[]; radiusKm?: number } & LookupMeta;
/** Cafés near the destination point (addendum A2); loaded only when a wish or change request asks for them. */
export type CafeLookup = { status: LookupStatus; cafes: Cafe[]; radiusKm?: number } & LookupMeta;

/**
 * A named stop of the trip, geocoded by code (docs/specs/port-places.md section 1). `destination` = within 5 km of the
 * trip destination (the destination's lookups apply, no own ones); `stop` = own lookups, id `s1..` in day order.
 * `status`: ok = found (has a point), not_found = no matching populated place, error = geocoding failed, cap = beyond
 * the 10 looked-up stops of a trip.
 */
export type ResolvedStop = {
  id: string;
  /** GeoNames name in the plan language (the typed name when nothing was found). */
  name: string;
  days: number[];
  role: "stop" | "destination";
  point?: { lat: number; lon: number; geoId: number };
  status: "ok" | "not_found" | "error" | "cap";
  /** Country of the geocoded place (ISO alpha-2); the stop's local-cuisine filter uses it, not the destination's. */
  countryCode?: string;
  /** Folded names as typed in the trip stops that resolved to this stop (they match `trip.stops` rows). */
  keys?: string[];
};

/** Lookups around one stop (section 2). Not persisted; the plan input carries the result. */
export type StopFacts = {
  stop: ResolvedStop;
  places: PlaceGroup[];
  restaurants?: RestaurantLookup;
  cafes?: CafeLookup;
};

export type TripFacts = {
  tripId: string;
  generatedAt: string;
  referenceDates: string[];
  weather: Fact<WeatherFacts>;
  daylight: Fact<DaylightFacts>;
  country: Fact<CountryFacts>;
  summary: Fact<DestinationSummary>;
  places: Fact<PlacesFacts>;   // outer fetchedAt = oldest group fetchedAt
  flights?: Fact<FlightsFacts>; // optional: only the plan pipeline fills it (phase 4)
  /** Activity groups the purpose wishes need (activities spec section 2); absent = none wished. */
  activities?: ActivityGroupLookup[];
  /** Restaurants near the destination point (activities spec section 3); absent in older callers. */
  restaurants?: RestaurantLookup;
  /** Cafés (addendum A2); absent unless the purpose asks for cafés. */
  cafes?: CafeLookup;
  /** Resolved stops of the trip and what was looked up around them (port-places); absent without stops. */
  stops?: StopFacts[];
};

/** Context for facts functions. `userId` is for api_calls logging (null for cron/seed). */
export type FactsCtx = {
  userId: string | null;
  locale: Locale;
  today: string; // YYYY-MM-DD, Europe/Berlin
};
