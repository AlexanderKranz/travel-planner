import type { InterestKey } from "./interests";
import type { FlightsFacts } from "./flights";
import type { Locale } from "./profile";
import type { ActivityGroup } from "@/lib/facts/activity-types";
import type { ActivityPlace } from "@/lib/facts/activity-places";
import type { Restaurant } from "@/lib/facts/cuisine";

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
export type ActivityGroupLookup = { group: ActivityGroup; status: LookupStatus; places: ActivityPlace[] } & LookupMeta;
export type RestaurantLookup = { status: LookupStatus; restaurants: Restaurant[]; radiusKm?: number } & LookupMeta;

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
};

/** Context for facts functions. `userId` is for api_calls logging (null for cron/seed). */
export type FactsCtx = {
  userId: string | null;
  locale: Locale;
  today: string; // YYYY-MM-DD, Europe/Berlin
};
