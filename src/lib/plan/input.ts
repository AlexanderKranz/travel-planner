import type { EntryTraits, TravelGroup } from "@/lib/domain/group";
import type { InterestOrGeneral, PlaceGroup, TripFacts } from "@/lib/domain/facts";
import type { GroupSummary, OsmKey, PlanFactsDigest, PlanHeader, PlanPlace } from "@/lib/domain/plan";
import type { Locale } from "@/lib/domain/profile";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import { tripRadiusKm, interestsForTrip, isInterestKey } from "@/lib/facts/interest-sources";
import { addDays, ageReferenceDate, selectedMonths } from "@/lib/facts/trip-timing";
import { resolveGroupAges, stripTraits } from "@/lib/group";
import { gatewayAirports, nearestGatewayKm } from "./airports";

/** What Sonnet sees (spec 3.1). Canonical JSON, compact keys, no timestamps or other volatile values. */
export type PlanInput = {
  v: 1;
  lang: "de" | "en";
  trip: {
    dest: string;
    place?: string;
    country?: string;
    kind: "city" | "region" | "freetext";
    radiusKm?: number;
    days: number;
    start?: string;
    end?: string;
    months?: number[];
    flights: boolean;
    notes?: string;
  };
  dayList: { n: number; date?: string; dow?: Dow; sunrise?: string; dusk?: string }[];
  /** Months mode only. */
  daylightByMonth?: { m: number; sunrise: string; dusk: string }[];
  group?: {
    size: number;
    notes?: string;
    entries: { n: number; age?: number; approx?: true; label?: string; traits?: EntryTraits; notes?: string }[];
  };
  purpose?: {
    name: string;
    pace?: string;
    budget?: string;
    rooms?: string;
    accommodation?: string[];
    interests: string[];
    hard: string[];
    soft: string[];
    summary?: string;
  };
  /** Selected months only. */
  climate?: { m: number; tmax: number; tmin: number; wet: number; sun: number }[];
  country?: { name: string; currency: string[]; drivingSide: "left" | "right"; tz?: string };
  /** Gateway airports (spec 3.2). */
  airports?: { iata: string; name: string; km: number }[];
  places: { id: string /* p1.. */; name: string; cat: string; km: number; ap?: number; i: string /* interest */ }[];
  /** Interests with no verified candidates. */
  noSource: string[];
};
type Dow = "Mo" | "Tu" | "We" | "Th" | "Fr" | "Sa" | "Su";

/** Stored per version: exact LLM input + place index (`p1` → OSM key and place). */
export type PlanInputStored = { llm: PlanInput; index: Record<string /* p1 */, { key: OsmKey; place: PlanPlace }> };

export type BuildPlanInputArgs = {
  trip: Trip;
  group: TravelGroup | null;
  purpose: TripPurpose | null;
  profileBirthdate: string | null;
  facts: TripFacts;
  locale: Locale;
  today: string;
};

export const MAX_PLACES = 40;
export const MIN_PLACES_PER_INTEREST = 8;
/** Raw purpose text is cut to this when tagging failed [D7]. */
export const FALLBACK_SUMMARY_CHARS = 600;

const DOW: Dow[] = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const dowOf = (iso: string): Dow => DOW[new Date(`${iso}T12:00:00Z`).getUTCDay()];
const round1 = (n: number) => Math.round(n * 10) / 10;

/** UTC ISO instant → local `HH:MM` in an IANA zone. */
export function localHhmm(instant: string | null, timeZone: string): string | undefined {
  if (!instant) return undefined;
  const d = new Date(instant);
  if (!Number.isFinite(d.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d);
  const h = parts.find((p) => p.type === "hour")?.value;
  const m = parts.find((p) => p.type === "minute")?.value;
  return h && m ? `${h}:${m}` : undefined;
}

function safeUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function groupInput(
  group: TravelGroup,
  refDate: string,
  profileBirthdate: string | null,
): { input: NonNullable<PlanInput["group"]>; summary: GroupSummary } {
  const resolved = resolveGroupAges(group.entries, refDate, profileBirthdate);
  const summary: GroupSummary = { total: 0, adults: 0, children: 0, toddlers: 0, unknown: 0 };
  const entries: NonNullable<PlanInput["group"]>["entries"] = resolved.map((r, i) => {
    const stored = group.entries[i];
    summary.total += r.count;
    if (r.age.status === "known") {
      const a = r.age.age;
      if (a <= 2) summary.toddlers += r.count;
      else if (a <= 17) summary.children += r.count;
      else summary.adults += r.count;
    } else if (r.age.status === "aboutMyAge") summary.adults += r.count;
    else summary.unknown += r.count;
    const traits = stripTraits(stored.traits, group.traitKeys);
    return {
      n: r.count,
      age: r.age.status === "known" ? r.age.age : undefined,
      approx: r.age.status === "known" && r.age.approximate ? (true as const) : undefined,
      // No names, no birthdates [D6].
      label: stored.label ?? (r.isSelf ? "self" : undefined),
      traits: Object.keys(traits).length ? traits : undefined,
      notes: stored.notes || undefined,
    };
  });
  return { input: { size: summary.total, notes: group.notes || undefined, entries }, summary };
}

function purposeInput(p: TripPurpose): NonNullable<PlanInput["purpose"]> {
  const g = p.guided ?? {};
  const t = p.tags;
  const interests: string[] = [];
  const add = (s: string) => {
    if (s && !interests.includes(s)) interests.push(s);
  };
  for (const i of g.interests ?? []) if (isInterestKey(i) || !t) add(i);
  for (const i of t?.interests ?? []) add(i);
  for (const i of t?.custom ?? []) add(i);
  return {
    name: p.name,
    pace: g.pace ?? t?.pace,
    budget: g.budget,
    rooms: g.rooms,
    accommodation: g.accommodation?.length ? g.accommodation : undefined,
    interests,
    // [D7]: tags replace the raw text; without tags the text (cut) and constraints go in as-is.
    hard: t ? t.hard : [...p.constraints],
    soft: t ? t.soft : [],
    summary: t ? t.summary || undefined : p.text?.slice(0, FALLBACK_SUMMARY_CHARS) || undefined,
  };
}

type PlacesOut = { places: PlanInput["places"]; index: PlanInputStored["index"]; noSource: string[] };

function placesInput(
  facts: TripFacts,
  lang: Locale,
  gateways: ReturnType<typeof gatewayAirports>,
  fallbackKeys: InterestOrGeneral[],
): PlacesOut {
  const out: PlacesOut = { places: [], index: {}, noSource: [] };
  if (facts.places.status !== "ok") {
    out.noSource = [...fallbackKeys];
    return out;
  }
  const groups = facts.places.data.groups;
  const ok = groups.filter((g): g is Extract<PlaceGroup, { status: "ok" }> => g.status === "ok");
  for (const g of groups) if (g.status !== "ok" && !out.noSource.includes(g.interest)) out.noSource.push(g.interest);
  const perInterest = Math.max(MIN_PLACES_PER_INTEREST, Math.floor(MAX_PLACES / Math.max(1, ok.length)));
  const seen = new Set<string>();
  for (const g of ok) {
    let taken = 0;
    for (const c of g.candidates) {
      if (out.places.length >= MAX_PLACES || taken >= perInterest) break;
      const key = `${c.osmType}/${c.osmId}` as OsmKey;
      if (seen.has(key)) continue;
      seen.add(key);
      taken += 1;
      const id = `p${out.places.length + 1}`;
      const name = c.names[lang] ?? c.name;
      const ap = nearestGatewayKm(c, gateways);
      out.places.push({ id, name, cat: c.category, km: round1(c.distanceKm), ap, i: g.interest });
      const place: PlanPlace = {
        name,
        category: c.category,
        lat: c.lat,
        lon: c.lon,
        distanceKm: round1(c.distanceKm),
        airportKm: ap,
        osmUrl: c.osmUrl,
        wikipedia: c.wikipedia,
        website: safeUrl(c.website),
        source: "osm",
        fetchedAt: g.fetchedAt,
      };
      for (const k of Object.keys(place) as (keyof PlanPlace)[]) if (place[k] === undefined) delete place[k];
      out.index[id] = { key, place };
    }
  }
  return out;
}

/**
 * Trip + context + facts → the exact LLM input, the place index, header and facts digest (spec 3.1). Pure.
 * Ages via `ageOn` at the age reference date; no names or birthdates leave this function.
 */
export function buildPlanInput(a: BuildPlanInputArgs): {
  stored: PlanInputStored;
  header: Omit<PlanHeader, "generatedAt" | "model">;
  digest: PlanFactsDigest;
} {
  const { trip, group, purpose, facts, locale, today } = a;
  const dest = trip.destination;
  const geo = dest.kind === "freetext" ? null : dest;
  const timing = trip.timing;
  const days = trip.lengthDays;
  const start = timing.kind === "date" ? timing.startDate : undefined;
  const end = start ? addDays(start, days - 1) : undefined;
  const country = facts.country.status === "ok" ? facts.country.data : null;
  const daylight = facts.daylight.status === "ok" ? facts.daylight.data : null;
  const tz = daylight?.timezone ?? geo?.timezone ?? undefined;

  // Daylight as local HH:MM.
  const dayLight = new Map<string, { sunrise?: string; dusk?: string }>();
  if (daylight) {
    for (const d of daylight.days) {
      dayLight.set(d.date, { sunrise: localHhmm(d.sunrise, daylight.timezone), dusk: localHhmm(d.dusk, daylight.timezone) });
    }
  }
  const dayList: PlanInput["dayList"] = Array.from({ length: days }, (_, i) => {
    const date = start ? addDays(start, i) : undefined;
    const l = date ? dayLight.get(date) : undefined;
    return { n: i + 1, date, dow: date ? dowOf(date) : undefined, sunrise: l?.sunrise, dusk: l?.dusk };
  });
  let daylightByMonth: PlanInput["daylightByMonth"];
  if (timing.kind === "months" && daylight) {
    daylightByMonth = daylight.days.flatMap((d) => {
      const l = dayLight.get(d.date);
      return l?.sunrise && l.dusk ? [{ m: Number(d.date.slice(5, 7)), sunrise: l.sunrise, dusk: l.dusk }] : [];
    });
  }

  const refDate = ageReferenceDate(trip, today) ?? today;
  const g = group ? groupInput(group, refDate, a.profileBirthdate) : null;

  const months = selectedMonths(trip);
  const weather = facts.weather.status === "ok" ? facts.weather : null;
  const climateMonths = weather && months.length ? weather.data.months.filter((m) => months.includes(m.month)) : [];

  const gateways = trip.wantsFlights && geo ? gatewayAirports(geo) : [];
  const fallbackKeys = interestsForTrip(purpose?.guided, purpose?.tags).keys;
  const pl = placesInput(facts, locale, gateways, fallbackKeys);

  const llm: PlanInput = {
    v: 1,
    lang: locale,
    trip: {
      dest: dest.name,
      place: geo && geo.placeName !== dest.name ? geo.placeName : undefined,
      country: country?.nameEn ?? dest.countryCode ?? undefined,
      kind: dest.kind,
      radiusKm: geo ? tripRadiusKm(geo) : undefined,
      days,
      start,
      end,
      months: timing.kind === "months" ? [...timing.months] : undefined,
      flights: trip.wantsFlights,
      notes: trip.notes || undefined,
    },
    dayList,
    daylightByMonth: daylightByMonth?.length ? daylightByMonth : undefined,
    group: g?.input,
    purpose: purpose ? purposeInput(purpose) : undefined,
    climate: climateMonths.length
      ? climateMonths.map((m) => ({ m: m.month, tmax: m.tMaxC, tmin: m.tMinC, wet: m.wetDays, sun: m.sunshineHours }))
      : undefined,
    country: country
      ? {
          name: country.nameEn,
          currency: country.currencies.map((c) => c.code),
          drivingSide: country.drivingSide,
          tz: country.timezone.iana ?? tz,
        }
      : undefined,
    airports: gateways.length ? gateways.map((x) => ({ iata: x.iata, name: x.name, km: Math.round(x.km) })) : undefined,
    places: pl.places,
    noSource: pl.noSource,
  };

  const header: Omit<PlanHeader, "generatedAt" | "model"> = {
    title: (trip.title || dest.name).slice(0, 120),
    destination: dest.name.slice(0, 120),
    timing:
      timing.kind === "date"
        ? { kind: "date", startDate: timing.startDate, endDate: end! }
        : timing.kind === "months"
          ? { kind: "months", months: [...timing.months] }
          : { kind: "none" },
    lengthDays: days,
    group: g?.summary ?? null,
    purposeName: purpose?.name.slice(0, 80) ?? null,
    basis: {
      tripUpdatedAt: trip.updatedAt,
      groupUpdatedAt: group?.updatedAt ?? null,
      purposeUpdatedAt: purpose?.updatedAt ?? null,
    },
  };

  const digest: PlanFactsDigest = {};
  if (weather && climateMonths.length) {
    digest.climate = {
      months: climateMonths.map((m) => ({
        month: m.month,
        tMaxC: m.tMaxC,
        tMinC: m.tMinC,
        wetDays: m.wetDays,
        sunshineHours: m.sunshineHours,
      })),
      period: weather.data.period,
      fetchedAt: weather.fetchedAt,
    };
  }
  if (daylight) {
    digest.daylight = {
      timezone: daylight.timezone,
      days: daylight.days.map((d) => ({
        date: d.date,
        sunrise: dayLight.get(d.date)?.sunrise ?? null,
        dusk: dayLight.get(d.date)?.dusk ?? null,
      })),
    };
  }
  if (llm.airports) digest.airports = llm.airports;
  if (facts.places.status === "ok") digest.placesFetchedAt = facts.places.fetchedAt;

  return { stored: { llm: stripUndefined(llm), index: pl.index }, header, digest };
}

/** Drops `undefined` keys so the stored jsonb equals what was hashed and sent. */
function stripUndefined<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
