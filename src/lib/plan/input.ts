import type { EntryTraits } from "@/lib/domain/group";
import type { InterestOrGeneral, PlaceCandidate, PlaceGroup, TripFacts } from "@/lib/domain/facts";
import type { GroupSummary, OsmKey, PlanFlights, PlanFactsDigest, PlanHeader, PlanPlace } from "@/lib/domain/plan";
import type { Locale } from "@/lib/domain/profile";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import { tripRadiusKm, interestsForTrip, isInterestKey } from "@/lib/facts/interest-sources";
import { addDays, ageReferenceDate, selectedMonths } from "@/lib/facts/trip-timing";
import { resolveGroup, type GroupSource } from "@/lib/group-text";
import { gatewayAirports, nearestGatewayKm } from "./airports";
import { fixedItemsOf, fixedSlots, type FixedSlot } from "./fixed-items";
import type { SharedItem } from "@/lib/domain/items";

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
  /** Verified direct flights at fitting times only (no numbers, airlines or dates). */
  flights?: {
    mode: "schedule" | "proxy";
    out: { f: string; t: string; dep: string; arr: string }[];
    back: { f: string; t: string; dep: string; arr: string }[];
  };
  /** km = straight line from the destination point, min = drive minutes from there (code-computed), ap = km to the airport. */
  places: { id: string /* p1.. */; name: string; cat: string; km: number; min?: number; ap?: number; i: string /* interest */ }[];
  /** Interests with no verified candidates. */
  noSource: string[];
  /** The user's booked/planned items with a day and start time (plan-4). Code renders them; the model plans around. */
  fixed?: FixedSlot[];
};
type Dow = "Mo" | "Tu" | "We" | "Th" | "Fr" | "Sa" | "Su";

/** Stored per version: exact LLM input + place index (`p1` → OSM key and place). */
export type PlanInputStored = { llm: PlanInput; index: Record<string /* p1 */, { key: OsmKey; place: PlanPlace }> };

/**
 * What the plan needs to know about the travellers: a saved group (TravelGroup fits), or the one-off group of a trip
 * (no saved entries of its own, only text, the user's corrected structure as `entries`, and the Haiku parse).
 */
export type GroupContext = GroupSource & { updatedAt: string };

export type BuildPlanInputArgs = {
  trip: Trip;
  group: GroupContext | null;
  purpose: TripPurpose | null;
  profileBirthdate: string | null;
  facts: TripFacts;
  locale: Locale;
  today: string;
  /** Drive times from the destination point by OSM key (OpenRouteService); null/absent = none. */
  drive?: DriveInput | null;
  /** Trip items; only booked/planned ones with day + start time reach the model as `fixed`. */
  items?: Pick<SharedItem, "id" | "day" | "startTime" | "endTime" | "category" | "title" | "status">[];
};

export type DriveInput = { byKey: Record<string, { min: number; km: number }>; fetchedAt: string };

export const MAX_PLACES = 40;
export const MAX_LLM_LEGS = 3;

type FlightsOut = { llm?: PlanInput["flights"]; snapshot?: PlanFlights; foundGateways: Set<string> };

/** Facts → LLM flight times (fitting legs only), the stored snapshot and the gateways with a verified route. */
export function flightsFrom(facts: TripFacts, wanted: boolean): FlightsOut {
  const f = wanted && facts.flights?.status === "ok" ? facts.flights : null;
  const out: FlightsOut = { foundGateways: new Set() };
  if (!f) return out;
  const d = f.data;
  for (const p of d.pairs) if (p.status === "found") out.foundGateways.add(p.to);
  const pick = (dir: "out" | "back") =>
    d.legs
      .filter((l) => l.dir === dir && !l.tooLong)
      .sort((a, b) => a.dep.localeCompare(b.dep))
      .slice(0, MAX_LLM_LEGS)
      .map((l) => ({ f: l.from, t: l.to, dep: l.dep, arr: l.arr }));
  const o = pick("out");
  const b = pick("back");
  if (o.length || b.length) out.llm = { mode: d.mode.out === "proxy" || d.mode.back === "proxy" ? "proxy" : "schedule", out: o, back: b };
  out.snapshot = {
    basis: d.basis,
    outDate: d.outDate,
    backDate: d.backDate,
    mode: d.mode,
    pairs: d.pairs.slice(0, 4).map((p) => ({ from: p.from, to: p.to, status: p.status, perDay: p.perDay })),
    legs: d.legs.slice(0, 12).map((l) => ({
      dir: l.dir,
      from: l.from,
      to: l.to,
      number: l.number,
      airline: l.airline,
      dep: l.dep,
      arr: l.arr,
      arrDayOffset: l.arrDayOffset,
      blockMin: l.blockMin,
      date: l.date,
      weekdays: l.weekdays,
      tooLong: l.tooLong,
    })),
    maxBlockMin: d.maxBlockMin,
    source: "aerodatabox",
    fetchedAt: f.fetchedAt,
  };
  return out;
}
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
  group: GroupContext,
  refDate: string,
  profileBirthdate: string | null,
): { input: NonNullable<PlanInput["group"]>; summary: GroupSummary } {
  // Resolution order (spec group-text [D5]): saved entries > Haiku parse > raw text as notes.
  const r = resolveGroup(group, refDate, profileBirthdate);
  const entries: NonNullable<PlanInput["group"]>["entries"] = r.rows.map((row) => ({
    n: row.count,
    age: row.age.status === "known" ? row.age.age : undefined,
    approx: row.age.status === "known" && row.age.approximate ? (true as const) : undefined,
    // No names, no birthdates [D6]. Parsed rows without an age carry their role as label.
    label: row.label ?? (row.isSelf ? "self" : row.age.status === "unknown" ? row.role : undefined),
    traits: row.traits,
    notes: row.notes,
  }));
  return { input: { size: r.size, notes: r.notes, entries }, summary: r.summary };
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

/** Cap for the pseudo interest "general" when the purpose has specific interests with places [D4]. */
export const GENERAL_CAP = 8;

export type PlacePick = { interest: InterestOrGeneral; c: PlaceCandidate; key: OsmKey; fetchedAt: string };

/**
 * Which candidates go into the LLM input (pure, also used for the drive-time request). Every interest with places
 * gets a fair share first (specific interests before "general", which is capped), then free slots are filled in
 * interest order up to MAX_PLACES. Result is grouped by interest in purpose order, so ids stay stable.
 */
export function selectPlaces(facts: TripFacts, fallbackKeys: InterestOrGeneral[]): { picks: PlacePick[]; noSource: string[] } {
  if (facts.places.status !== "ok") return { picks: [], noSource: [...fallbackKeys] };
  const groups = facts.places.data.groups;
  const noSource: string[] = [];
  for (const g of groups) if (g.status !== "ok" && !noSource.includes(g.interest)) noSource.push(g.interest);
  const ok = groups.filter((g): g is Extract<PlaceGroup, { status: "ok" }> => g.status === "ok");
  const specific = ok.filter((g) => g.interest !== "general").length;
  const share = Math.max(MIN_PLACES_PER_INTEREST, Math.floor(MAX_PLACES / Math.max(1, ok.length)));
  const quota = (g: (typeof ok)[number]) => (g.interest === "general" && specific > 0 ? Math.min(share, GENERAL_CAP) : share);
  const seen = new Set<string>();
  const taken = ok.map(() => [] as PlacePick[]);
  const cursor = ok.map(() => 0);
  let total = 0;
  const take = (gi: number, limit: number) => {
    const g = ok[gi];
    while (total < MAX_PLACES && taken[gi].length < limit && cursor[gi] < g.candidates.length) {
      const c = g.candidates[cursor[gi]++];
      const key = `${c.osmType}/${c.osmId}` as OsmKey;
      if (seen.has(key)) continue;
      seen.add(key);
      taken[gi].push({ interest: g.interest, c, key, fetchedAt: g.fetchedAt });
      total += 1;
    }
  };
  // Pass 1: fair share, specific interests first. Pass 2: fill the rest (general last, still capped).
  const order = ok.map((_, i) => i).sort((a, b) => Number(ok[a].interest === "general") - Number(ok[b].interest === "general"));
  for (const gi of order) take(gi, quota(ok[gi]));
  for (const gi of order) take(gi, ok[gi].interest === "general" && specific > 0 ? quota(ok[gi]) : Infinity);
  return { picks: taken.flat(), noSource };
}

function placesInput(
  facts: TripFacts,
  lang: Locale,
  gateways: ReturnType<typeof gatewayAirports>,
  fallbackKeys: InterestOrGeneral[],
  drive: DriveInput | null | undefined,
): PlacesOut {
  const sel = selectPlaces(facts, fallbackKeys);
  const out: PlacesOut = { places: [], index: {}, noSource: sel.noSource };
  for (const { interest, c, key, fetchedAt } of sel.picks) {
    const id = `p${out.places.length + 1}`;
    const name = c.names[lang] ?? c.name;
    const ap = nearestGatewayKm(c, gateways);
    const d = drive?.byKey[key];
    out.places.push({ id, name, cat: c.category, km: round1(c.distanceKm), min: d?.min, ap, i: interest });
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
      fetchedAt,
      drive: d && drive ? { min: d.min, km: d.km, source: "openrouteservice", fetchedAt: drive.fetchedAt } : undefined,
    };
    for (const k of Object.keys(place) as (keyof PlanPlace)[]) if (place[k] === undefined) delete place[k];
    out.index[id] = { key, place };
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
  /** Code snapshot for `plan.flights` (never from the model). */
  flights: PlanFlights | undefined;
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

  const fixed = fixedSlots(fixedItemsOf(a.items ?? [], days));
  const fl = flightsFrom(facts, trip.wantsFlights);
  // A booked/planned flight on day 1 (last day) replaces the verified-schedule heuristic for that direction [D5].
  if (fl.llm && fixed) {
    const flightOn = (n: number) => fixed.some((f) => f.cat === "flight" && f.day === n);
    const out = flightOn(1) ? [] : fl.llm.out;
    const back = flightOn(days) ? [] : fl.llm.back;
    fl.llm = out.length || back.length ? { ...fl.llm, out, back } : undefined;
  }
  let gateways = trip.wantsFlights && geo ? gatewayAirports(geo) : [];
  // Gateways with a verified route replace the distance heuristic (spec D10).
  const verified = gateways.filter((x) => fl.foundGateways.has(x.iata));
  if (verified.length) gateways = verified;
  const fallbackKeys = interestsForTrip(purpose?.guided, purpose?.tags).keys;
  const pl = placesInput(facts, locale, gateways, fallbackKeys, a.drive);

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
    flights: fl.llm,
    places: pl.places,
    noSource: pl.noSource,
    fixed,
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

  return {
    stored: { llm: stripUndefined(llm), index: pl.index },
    header,
    digest,
    flights: fl.snapshot ? stripUndefined(fl.snapshot) : undefined,
  };
}

/** Drops `undefined` keys so the stored jsonb equals what was hashed and sent. */
function stripUndefined<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
