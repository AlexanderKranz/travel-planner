/**
 * Reference trip fixture → Trip/group/purpose + recorded facts → buildPlanInput (spec 7). No network:
 * places, climate and country come from recorded provider responses, daylight from suncalc.
 * Imports server-only integration parsers: test files must `vi.mock("server-only", () => ({}))`.
 */
import golfJson from "./fixtures/golftrip-costa-del-sol.json";
import cruiseJson from "./fixtures/donau-kreuzfahrt.json";
import golfOsm from "@/lib/integrations/__fixtures__/overpass/golf-marbella-40km.json";
import passauOsm from "@/lib/integrations/__fixtures__/overpass/general-passau-15km.json";
import passauFamilyOsm from "@/lib/integrations/__fixtures__/overpass/family-passau-25km.json";
import fraDeparturesPast from "@/lib/integrations/__fixtures__/aerodatabox/fids-departures-FRA-2026-03-07-past.json";
import agpDeparturesPast from "@/lib/integrations/__fixtures__/aerodatabox/fids-departures-AGP-2026-03-18-past.json";
import malagaArchive from "@/lib/integrations/__fixtures__/open-meteo/archive-malaga-2016-2025.json";
import type { FlightsFacts } from "@/lib/domain/flights";
import type { ItemCategory, ItemStatus, SharedItem } from "@/lib/domain/items";
import type { CountryFacts, Fact, InterestOrGeneral, PlaceGroup, TripFacts, WeatherFacts } from "@/lib/domain/facts";
import type { StoredEntry, TravelGroup } from "@/lib/domain/group";
import type { PlanFeedback, PurposeTags } from "@/lib/domain/plan";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import { CLIMATE_PERIOD, aggregateClimate } from "@/lib/facts/climate";
import { daylightFor } from "@/lib/facts/daylight";
import { interestsForTrip, radiusForInterest, sourceFor } from "@/lib/facts/interest-sources";
import { rankCandidates } from "@/lib/facts/places";
import { daylightDates, selectedMonths } from "@/lib/facts/trip-timing";
import { getCountry } from "@/lib/integrations/countries";
import { parseArchive } from "@/lib/integrations/open-meteo-archive";
import { parseElements } from "@/lib/integrations/overpass";
import { buildPlanInput, selectPlaces, type DriveInput } from "@/lib/plan/input";
import { existsSync, readFileSync } from "node:fs";
import { recordingPath } from "./recorded";
import { gatewayAirports } from "@/lib/plan/airports";
import { buildFlightsFacts } from "@/lib/flights/build";
import { maxBlockMinutes } from "@/lib/flights/constraint";
import { flightDates } from "@/lib/flights/lookups";
import { normalizeFids } from "@/lib/integrations/aerodatabox-normalize";

export const FIXTURE_IDS = ["golf", "cruise"] as const;
export type FixtureId = (typeof FIXTURE_IDS)[number];

/** Fixed clock and profile so inputs (and their hashes) are stable. */
export const EVAL_TODAY = "2026-10-28";
export const EVAL_FETCHED_AT = "2026-10-28T00:00:00.000Z";
export const EVAL_PROFILE_BIRTHDATE = "1988-04-12";
export const EVAL_UPDATED_AT = "2026-10-28T08:00:00.000Z";

type Composition = { count: number; ageMode: "relativeToMe" | "approx" | "exact"; age?: number; label?: string };
export type ScheduleEntry = { date: string; place: string; arrive?: string; depart?: string };
export type EvalFixture = {
  locale: "de" | "en";
  trip: {
    destination: { name: string; kind: "city" | "region" };
    anchor: { placeName: string; countryCode: string; lat: number; lon: number; timezone: string; radiusKm: number };
    startDate: string;
    endDate: string;
    flights: boolean;
    originAirports?: string[];
  };
  group?: { composition: Composition[]; notes?: string };
  purpose?: { name: string; text?: string; constraints?: string[] };
  fixedSchedule?: ScheduleEntry[];
  /** Trip items (timed-items spec); booked/planned ones with day + start reach the model as `fixed`. */
  items?: { category: ItemCategory; title: string; status: ItemStatus; day: number | null; startTime?: string; endTime?: string }[];
  checks: {
    sportEveryDay?: boolean;
    /** A day other than the first and last has >= 2 rounds (the input does not say which day). */
    twoRoundsOnOneDay?: boolean;
    airportNearDays?: number[];
    airportMaxKm?: number;
    restWindow?: [string, string];
    restExceptDays?: number[];
    portWindows?: "fixedSchedule";
    /** Day 1 starts >= 90 min after a fixed arrival flight; no activity overlaps a fixed item. */
    fixedItems?: boolean;
  };
};

export const FIXTURES: Record<FixtureId, EvalFixture> = {
  golf: golfJson as unknown as EvalFixture,
  cruise: cruiseJson as unknown as EvalFixture,
};

/** Recorded Overpass responses per interest; other OSM interests count as "error" (not recorded). */
const OSM: Record<FixtureId, Partial<Record<InterestOrGeneral, unknown>>> = {
  golf: { golf: golfOsm },
  // family_activities recorded live 2026-10-28 (overpass-api.de, the production query for 25 km around Passau).
  cruise: { general: passauOsm, city_sightseeing: passauOsm, family_activities: passauFamilyOsm },
};

/** Patch feedback per fixture (spec 7). */
export const PATCH_FEEDBACK: Record<FixtureId, PlanFeedback> = {
  cruise: { chips: ["more_rest"], days: [2] },
  golf: { chips: ["redo_day"], days: [4] },
};

const dayCount = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;

/** "Hafenzeiten" block as a user would type it into the trip notes (German fixture). */
export function scheduleNotes(s: ScheduleEntry[]): string {
  const lines = s.map((e) => {
    const parts = [e.date, e.place];
    if (e.arrive) parts.push(/^\d\d:\d\d$/.test(e.arrive) ? `an ${e.arrive}` : `an ${e.arrive === "morning" ? "morgens" : e.arrive}`);
    if (e.depart) parts.push(`ab ${e.depart}`);
    return parts.join(" ");
  });
  return `Schiff, feste Hafenzeiten:\n${lines.join("\n")}`;
}

export function evalTrip(id: FixtureId): Trip {
  const f = FIXTURES[id];
  const a = f.trip.anchor;
  return {
    id: `eval-${id}`,
    destination: {
      kind: f.trip.destination.kind,
      name: f.trip.destination.name,
      placeName: a.placeName,
      geoId: 1,
      countryCode: a.countryCode,
      admin1: null,
      lat: a.lat,
      lon: a.lon,
      timezone: a.timezone,
      radiusKm: a.radiusKm,
    },
    lengthDays: dayCount(f.trip.startDate, f.trip.endDate),
    timing: { kind: "date", startDate: f.trip.startDate },
    groupId: f.group ? `eval-${id}-group` : null,
    purposeId: f.purpose ? `eval-${id}-purpose` : null,
    wantsFlights: f.trip.flights,
    originAirports: f.trip.originAirports ?? [],
    notes: f.fixedSchedule ? scheduleNotes(f.fixedSchedule) : undefined,
    createdAt: EVAL_UPDATED_AT,
    updatedAt: EVAL_UPDATED_AT,
  };
}

export function evalGroup(id: FixtureId): TravelGroup | null {
  const g = FIXTURES[id].group;
  if (!g) return null;
  const entries: StoredEntry[] = g.composition.map((c, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    position: i,
    kind: "composition",
    count: c.count,
    label: c.label,
    traits: {},
    age: c.ageMode === "relativeToMe" ? { ageMode: "relativeToMe" } : { ageMode: c.ageMode, age: c.age ?? 0 },
    // no ageAsOf: the fixture states ages at travel time
  }));
  return { id: `eval-${id}-group`, name: "Eval", notes: g.notes, traitKeys: [], createdAt: EVAL_UPDATED_AT, updatedAt: EVAL_UPDATED_AT, entries };
}

export function evalPurpose(id: FixtureId, tags: PurposeTags | null): TripPurpose | null {
  const p = FIXTURES[id].purpose;
  if (!p) return null;
  return {
    id: `eval-${id}-purpose`,
    name: p.name,
    text: p.text,
    guided: {},
    constraints: p.constraints ?? [],
    tags,
    createdAt: EVAL_UPDATED_AT,
    updatedAt: EVAL_UPDATED_AT,
  };
}

function weatherFact(id: FixtureId, trip: Trip): Fact<WeatherFacts> {
  if (id !== "golf") return { status: "unavailable", reason: "not_found" };
  return {
    status: "ok",
    data: { months: aggregateClimate(parseArchive(malagaArchive)), selectedMonths: selectedMonths(trip), period: CLIMATE_PERIOD },
    source: "open_meteo",
    fetchedAt: EVAL_FETCHED_AT,
    stale: false,
  };
}

function countryFact(code: string, timezone: string): Fact<CountryFacts> {
  const c = getCountry(code);
  if (!c) return { status: "unavailable", reason: "not_found" };
  return {
    status: "ok",
    data: { code, ...c, timezone: { iana: timezone, utcOffsets: [], countryZones: [] }, plugs: null },
    source: "rest_countries",
    fetchedAt: EVAL_FETCHED_AT,
    stale: false,
  };
}

/**
 * Flights via the real pure builder from recorded AeroDataBox departures (golf only). 2038 is beyond the horizon,
 * so both directions are proxies (checked 2026-03-14 / 2026-03-18). The outbound FIDS fixture was recorded on
 * 2026-03-07 (same weekday, same schedule) and stands in for the checked date, as in build.test.ts.
 * No routes fixture for the month: routes = not checked, so every gateway is tried.
 */
function flightsFact(id: FixtureId, trip: Trip, purpose: TripPurpose | null): Fact<FlightsFacts> | null {
  if (id !== "golf" || !trip.wantsFlights) return null;
  const dates = flightDates(trip, EVAL_TODAY);
  if (!dates) return null;
  const gateways = gatewayAirports(FIXTURES[id].trip.anchor).map(({ iata, name, km }) => ({ iata, name, km }));
  const origins = trip.originAirports;
  const data = buildFlightsFacts({
    today: EVAL_TODAY,
    dates,
    origins,
    gateways,
    maxBlockMin: maxBlockMinutes(purpose),
    routes: Object.fromEntries(origins.map((o) => [o, null])),
    departures: {
      out: { FRA: { data: normalizeFids(fraDeparturesPast), complete: true } },
      back: { AGP: { data: normalizeFids(agpDeparturesPast), complete: true } },
    },
    flightDates: {},
    quotaLimited: false,
  });
  return { status: "ok", data, source: "aerodatabox", sourceUrl: "https://aerodatabox.com", fetchedAt: EVAL_FETCHED_AT, stale: false };
}

export function evalFacts(id: FixtureId, trip: Trip, purpose: TripPurpose | null): TripFacts {
  const a = FIXTURES[id].trip.anchor;
  const anchor = { lat: Number(a.lat.toFixed(3)), lon: Number(a.lon.toFixed(3)) };
  const { keys, customInterests } = interestsForTrip(purpose?.guided, purpose?.tags);
  const groups: PlaceGroup[] = keys.map((interest) => {
    const src = sourceFor(interest);
    if (src.source === "none") return { interest, status: "no_source" };
    const raw = OSM[id][interest];
    if (!raw) return { interest, status: "error" };
    const candidates = rankCandidates(parseElements(raw), src.filters, anchor, src.exclude, radiusForInterest(interest, a.radiusKm));
    return candidates.length
      ? { interest, status: "ok", candidates, fetchedAt: EVAL_FETCHED_AT, stale: false }
      : { interest, status: "empty", fetchedAt: EVAL_FETCHED_AT, stale: false };
  });
  const { basis, dates } = daylightDates(trip, EVAL_TODAY);
  const flights = flightsFact(id, trip, purpose);
  return {
    tripId: trip.id,
    generatedAt: EVAL_FETCHED_AT,
    referenceDates: dates,
    weather: weatherFact(id, trip),
    daylight: {
      status: "ok",
      data: { timezone: a.timezone, basis, days: daylightFor(a.lat, a.lon, dates) },
      source: "suncalc",
      fetchedAt: EVAL_FETCHED_AT,
      stale: false,
    },
    country: countryFact(a.countryCode, a.timezone),
    summary: { status: "unavailable", reason: "not_found" },
    // Recorded flights (golf only), built by the pure builder. Cruise has flights: false.
    ...(flights ? { flights } : {}),
    places: {
      status: "ok",
      data: { radiusKm: a.radiusKm, groups, customInterests },
      source: "osm",
      fetchedAt: EVAL_FETCHED_AT,
      stale: false,
    },
  };
}

/** Recorded drive times: OSM key → {min, km} from one live ORS matrix call (`EVAL_TASK=drive`). */
export type DriveRecording = { source: "openrouteservice"; recordedAt: string; origin: { lat: number; lon: number }; byKey: Record<string, { min: number; km: number }> };

/** The places the pipeline would send to ORS for this fixture (origin = destination point). */
export function evalDrivePicks(id: FixtureId, tags: PurposeTags | null) {
  const trip = evalTrip(id);
  const purpose = evalPurpose(id, tags);
  const facts = evalFacts(id, trip, purpose);
  const a = FIXTURES[id].trip.anchor;
  const picks = selectPlaces(facts, interestsForTrip(purpose?.guided, purpose?.tags).keys).picks;
  return { origin: { lat: a.lat, lon: a.lon }, places: picks.map((p) => ({ key: p.key, lat: p.c.lat, lon: p.c.lon })) };
}

function evalDrive(id: FixtureId): DriveInput | null {
  const p = recordingPath(id, "drive");
  if (!existsSync(p)) return null;
  const rec = JSON.parse(readFileSync(p, "utf8")) as DriveRecording;
  return { byKey: rec.byKey, fetchedAt: EVAL_FETCHED_AT };
}

/** Fixture items as trip items (stable ids, no prices). */
export function evalItems(id: FixtureId): SharedItem[] {
  return (FIXTURES[id].items ?? []).map((i, n) => ({
    id: `eval-${id}-item-${n + 1}`,
    category: i.category,
    title: i.title,
    status: i.status,
    priceCents: null,
    priceBasis: "total",
    persons: null,
    currency: "EUR",
    day: i.day,
    ref: null,
    url: null,
    notes: null,
    startTime: i.startTime ?? null,
    endTime: i.endTime ?? null,
  }));
}

/** Everything the pipeline would build for this fixture, given (recorded or live) purpose tags. */
export function buildEvalInput(id: FixtureId, tags: PurposeTags | null) {
  const trip = evalTrip(id);
  const group = evalGroup(id);
  const purpose = evalPurpose(id, tags);
  const facts = evalFacts(id, trip, purpose);
  const built = buildPlanInput({
    drive: evalDrive(id),
    items: evalItems(id),
    trip,
    group,
    purpose,
    profileBirthdate: EVAL_PROFILE_BIRTHDATE,
    facts,
    locale: FIXTURES[id].locale,
    today: EVAL_TODAY,
  });
  return { trip, group, purpose, facts, ...built };
}
