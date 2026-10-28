import { describe, expect, it } from "vitest";
import type { PlaceCandidate, PlaceGroup, TripFacts } from "@/lib/domain/facts";
import type { TravelGroup } from "@/lib/domain/group";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import { daylightFor } from "@/lib/facts/daylight";
import { canonicalJson, planInputHash } from "./hash";
import { buildPlanInput, localHhmm } from "./input";

const T = "2026-10-01T00:00:00.000Z";
const trip = (over: Partial<Trip> = {}): Trip => ({
  id: "t1",
  title: "Golf",
  destination: {
    kind: "region", name: "Costa del Sol", placeName: "Marbella", geoId: 1, countryCode: "ES", admin1: null,
    lat: 36.515, lon: -4.886, timezone: "Europe/Madrid", radiusKm: 40,
  },
  lengthDays: 3,
  timing: { kind: "date", startDate: "2038-03-13" },
  groupId: "g1",
  purposeId: "p1",
  wantsFlights: true,
  originAirports: [],
  notes: "Ankunft 09:00",
  createdAt: T,
  updatedAt: T,
  ...over,
});

const group: TravelGroup = {
  id: "g1", name: "Familie", notes: "Buggy", traitKeys: ["needsNap"], createdAt: T, updatedAt: "2026-10-02T00:00:00.000Z",
  entries: [
    { id: "e1", position: 0, kind: "member", isSelf: true, traits: {} },
    { id: "e2", position: 1, kind: "member", isSelf: false, name: "Emma Secret", birthdate: "2036-06-01", label: "Kleinkind", traits: { needsNap: true, diet: ["vegan"] } },
    { id: "e3", position: 2, kind: "composition", count: 2, age: { ageMode: "relativeToMe" }, traits: {} },
    { id: "e4", position: 3, kind: "composition", count: 1, traits: {}, notes: "Oma" },
  ],
};

const purpose = (over: Partial<TripPurpose> = {}): TripPurpose => ({
  id: "p1", name: "Golftrip", text: "Jeden Tag Golf, ".repeat(60), guided: { interests: ["golf", "Pilze"], pace: "packed" },
  constraints: ["flat courses"], tags: null, createdAt: T, updatedAt: T, ...over,
});

const cand = (i: number, interest: string): PlaceCandidate => ({
  osmType: "way", osmId: 1000 + i, name: `${interest} ${i}`, names: i === 0 ? { de: `${interest} DE` } : {},
  category: interest === "golf" ? "leisure=golf_course" : "tourism=attraction", lat: 36.5 + i / 100, lon: -4.9,
  distanceKm: i + 0.04, osmUrl: `https://www.openstreetmap.org/way/${1000 + i}`, website: i === 1 ? "not a url" : undefined,
});
const okGroup = (interest: "golf" | "general", n: number, offset = 0): PlaceGroup => ({
  interest, status: "ok", candidates: Array.from({ length: n }, (_, i) => cand(i + offset, interest)), fetchedAt: T, stale: false,
});

const facts = (t: Trip, groups: PlaceGroup[]): TripFacts => ({
  tripId: "t1", generatedAt: "2026-10-28T10:00:00.000Z", referenceDates: [],
  weather: { status: "ok", data: { months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, tMaxC: 20, tMinC: 10, precipMm: 30, wetDays: 5, sunshineHours: 8 })), selectedMonths: [3], period: { from: 2016, to: 2025 } }, source: "open_meteo", fetchedAt: T, stale: false },
  daylight: { status: "ok", data: { timezone: "Europe/Madrid", basis: "trip_dates", days: daylightFor(36.515, -4.886, t.timing.kind === "date" ? ["2038-03-13", "2038-03-14", "2038-03-15"] : t.timing.kind === "months" ? ["2027-03-15"] : []) }, source: "suncalc", fetchedAt: T, stale: false },
  country: { status: "ok", data: { code: "ES", nameEn: "Spain", capital: ["Madrid"], currencies: [{ code: "EUR" }], languages: [], callingCodes: ["+34"], drivingSide: "right", timezone: { iana: "Europe/Madrid", utcOffsets: [], countryZones: [] }, plugs: null }, source: "rest_countries", fetchedAt: T, stale: false },
  summary: { status: "unavailable", reason: "not_found" },
  places: { status: "ok", data: { radiusKm: 40, groups, customInterests: [] }, source: "osm", fetchedAt: T, stale: false },
});

const build = (t = trip(), p: TripPurpose | null = purpose(), groups = [okGroup("golf", 30), okGroup("general", 30, 100), { interest: "christmas_markets", status: "no_source" } as PlaceGroup]) =>
  buildPlanInput({ trip: t, group, purpose: p, profileBirthdate: "1980-05-01", facts: facts(t, groups), locale: "de", today: "2026-10-28" });

describe("buildPlanInput", () => {
  it("sends ages, labels and traits but no names or birthdates", () => {
    const { stored, header } = build();
    const json = canonicalJson(stored);
    expect(json).not.toMatch(/Emma|Secret|2036-06-01|1980-05-01|birth/);
    expect(stored.llm.group!.entries).toEqual([
      { n: 1, age: 57, label: "self" },
      { n: 1, age: 1, label: "Kleinkind", traits: { needsNap: true } }, // diet not enabled -> stripped
      { n: 2, age: 57, approx: true },
      { n: 1, notes: "Oma" },
    ]);
    expect(stored.llm.group!.size).toBe(5);
    expect(header.group).toEqual({ total: 5, adults: 3, children: 0, toddlers: 1, unknown: 1 });
  });

  it("has no volatile values and a stable hash", () => {
    const a = build();
    const b = build();
    expect(canonicalJson(a.stored.llm)).not.toMatch(/fetchedAt|generatedAt|2026-10-28T/);
    expect(planInputHash(a.stored.llm)).toBe(planInputHash(b.stored.llm));
  });

  it("takes max 40 places with stable p ids and localized names", () => {
    const { stored } = build();
    const pl = stored.llm.places;
    expect(pl).toHaveLength(40);
    expect(pl.map((p) => p.id)).toEqual(Array.from({ length: 40 }, (_, i) => `p${i + 1}`));
    expect(pl.filter((p) => p.i === "golf")).toHaveLength(20);
    expect(pl[0].name).toBe("golf DE");
    expect(pl[0].km).toBe(0);
    expect(stored.index.p1.key).toBe("way/1000");
    expect(stored.index.p1.place.fetchedAt).toBe(T);
    expect(stored.index.p2.place.website).toBeUndefined();
    expect(stored.llm.noSource).toEqual(["christmas_markets"]);
  });

  it("dedupes a place that appears in two interests", () => {
    const { stored } = build(trip(), purpose(), [okGroup("golf", 3), okGroup("general", 3)]);
    expect(stored.llm.places).toHaveLength(3);
  });

  it("adds gateway airports and ap only when flights are wanted", () => {
    const withF = build();
    expect(withF.stored.llm.airports?.[0].iata).toBe("AGP");
    expect(withF.stored.llm.places[0].ap).toBeTypeOf("number");
    expect(withF.digest.airports).toEqual(withF.stored.llm.airports);
    const noF = build(trip({ wantsFlights: false }));
    expect(noF.stored.llm.airports).toBeUndefined();
    expect(noF.stored.llm.places[0].ap).toBeUndefined();
  });

  it("dated trip: dates, weekdays, local daylight, climate of the trip month", () => {
    const { stored, header, digest } = build();
    expect(stored.llm.dayList[0]).toMatchObject({ n: 1, date: "2038-03-13", dow: "Sa" });
    expect(stored.llm.dayList[0].sunrise).toMatch(/^0[78]:\d\d$/);
    expect(stored.llm.trip).toMatchObject({ start: "2038-03-13", end: "2038-03-15", country: "Spain", place: "Marbella" });
    expect(stored.llm.climate).toEqual([{ m: 3, tmax: 20, tmin: 10, wet: 5, sun: 8 }]);
    expect(header.timing).toEqual({ kind: "date", startDate: "2038-03-13", endDate: "2038-03-15" });
    expect(digest.daylight?.days).toHaveLength(3);
  });

  it("undated trip: no date/dow; months trip: daylightByMonth", () => {
    const none = build(trip({ timing: { kind: "none" } }));
    expect(none.stored.llm.dayList[0]).toEqual({ n: 1 });
    expect(none.stored.llm.climate).toBeUndefined();
    const months = build(trip({ timing: { kind: "months", months: [3] } }));
    expect(months.stored.llm.daylightByMonth?.[0].m).toBe(3);
    expect(months.stored.llm.trip.months).toEqual([3]);
  });

  it("purpose: tags replace the raw text; without tags text (cut) and constraints go in", () => {
    const raw = build().stored.llm.purpose!;
    expect(raw.summary).toHaveLength(600);
    expect(raw.hard).toEqual(["flat courses"]);
    expect(raw.interests).toEqual(["golf", "Pilze"]);
    const tagged = build(trip(), purpose({ tags: { v: 1, interests: ["golf", "beach"], custom: ["mushrooms"], hard: ["golf daily"], soft: ["sea view"], summary: "Golf." } })).stored.llm.purpose!;
    expect(tagged).toMatchObject({ hard: ["golf daily"], soft: ["sea view"], summary: "Golf.", pace: "packed" });
    expect(tagged.interests).toEqual(["golf", "beach", "mushrooms"]);
    expect(canonicalJson(tagged)).not.toContain("Jeden Tag");
  });

  it("works with nothing but a freetext destination", () => {
    const t = trip({ destination: { kind: "freetext", name: "Irgendwo", countryCode: null }, timing: { kind: "none" }, notes: undefined });
    const r = buildPlanInput({ trip: t, group: null, purpose: null, profileBirthdate: null, facts: { ...facts(t, []), places: { status: "unavailable", reason: "no_location" }, daylight: { status: "unavailable", reason: "no_location" }, country: { status: "unavailable", reason: "no_country" } }, locale: "en", today: "2026-10-28" });
    expect(r.stored.llm).toMatchObject({ lang: "en", trip: { dest: "Irgendwo", kind: "freetext", days: 3, flights: true }, places: [], noSource: ["general"] });
    expect(r.header.group).toBeNull();
  });
});

describe("localHhmm", () => {
  it("formats an instant in the destination zone", () => {
    expect(localHhmm("2037-12-19T15:49:00.000Z", "Europe/Berlin")).toBe("16:49");
    expect(localHhmm(null, "Europe/Berlin")).toBeUndefined();
  });
});
