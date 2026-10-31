import { describe, expect, it } from "vitest";
import { TripInput } from "@/lib/domain/trip";
import type { GeoPlace } from "@/lib/domain/geo";
import { groupTextHash } from "@/lib/plan/hash";
import { buildTripWrite, factsInputsChanged, rowToTrip, type TripRow } from "./trip-mapping";

const place: GeoPlace = {
  geoId: 2513918,
  name: "Marbella",
  featureCode: "PPLA3",
  countryCode: "ES",
  admin1: "Andalusia",
  lat: 36.51,
  lon: -4.88,
  timezone: "Europe/Madrid",
  population: 140000,
  suggestedKind: "city",
};

describe("buildTripWrite", () => {
  it("destination + length only: everything else defaults", () => {
    const input = TripInput.parse({ destination: { kind: "freetext", name: "Irgendwo" }, lengthDays: 3 });
    const w = buildTripWrite(input, null);
    expect(w).toMatchObject({
      dest_kind: "freetext",
      dest_name: "Irgendwo",
      dest_lat: null,
      dest_geo_id: null,
      dest_radius_km: null,
      start_date: null,
      months: [],
      group_id: null,
      wants_flights: false,
      origin_airports: [],
      title: null,
      notes: null,
    });
  });

  it("geocoded: coordinates come from the place lookup, name defaults to the place", () => {
    const input = TripInput.parse({ destination: { kind: "city", geoId: 2513918 }, lengthDays: 5 });
    const w = buildTripWrite(input, place);
    expect(w).toMatchObject({
      dest_name: "Marbella",
      dest_place_name: "Marbella",
      dest_geo_id: 2513918,
      dest_lat: 36.51,
      dest_lon: -4.88,
      dest_country_code: "ES",
      dest_timezone: "Europe/Madrid",
      dest_radius_km: null,
    });
  });

  it("region with custom name and radius; months timing", () => {
    const input = TripInput.parse({
      destination: { kind: "region", geoId: 2513918, name: "Costa del Sol", radiusKm: 40 },
      lengthDays: 5,
      timing: { kind: "months", months: [4, 3, 3] },
    });
    const w = buildTripWrite(input, place);
    expect(w).toMatchObject({ dest_name: "Costa del Sol", dest_place_name: "Marbella", dest_radius_km: 40, months: [3, 4], start_date: null });
  });

  it("date timing clears months; freetext keeps its optional country", () => {
    const input = TripInput.parse({
      destination: { kind: "freetext", name: "Alpen", countryCode: "AT" },
      lengthDays: 2,
      timing: { kind: "date", startDate: "2027-01-05" },
    });
    expect(buildTripWrite(input, place)).toMatchObject({
      start_date: "2027-01-05",
      months: [],
      dest_country_code: "AT",
      dest_lat: null,
    });
  });
});

const row: TripRow = {
  id: "t1",
  title: null,
  dest_kind: "region",
  dest_name: "Costa del Sol",
  dest_place_name: "Marbella",
  dest_geo_id: 2513918,
  dest_country_code: "ES",
  dest_admin1: null,
  dest_lat: 36.51,
  dest_lon: -4.88,
  dest_timezone: "Europe/Madrid",
  dest_radius_km: null,
  length_days: 5,
  start_date: null,
  months: [3],
  group_id: null,
  group_text: null,
  group_structure: null,
  group_parsed: null,
  group_parsed_hash: null,
  purpose_id: null,
  wants_flights: true,
  origin_airports: [],
  notes: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("rowToTrip", () => {
  it("applies the default radius by kind and derives timing", () => {
    const t = rowToTrip(row);
    expect(t.destination).toMatchObject({ kind: "region", radiusKm: 40, placeName: "Marbella" });
    expect(t.timing).toEqual({ kind: "months", months: [3] });
    expect(t.title).toBeUndefined();
    expect(rowToTrip({ ...row, dest_kind: "city" }).destination).toMatchObject({ radiusKm: 15 });
    expect(rowToTrip({ ...row, months: [], start_date: "2027-03-01" }).timing).toEqual({ kind: "date", startDate: "2027-03-01" });
    expect(rowToTrip({ ...row, months: [] }).timing).toEqual({ kind: "none" });
  });
});

describe("factsInputsChanged", () => {
  const write = buildTripWrite(
    TripInput.parse({
      destination: { kind: "region", geoId: 2513918, name: "Costa del Sol" },
      lengthDays: 5,
      timing: { kind: "months", months: [3] },
    }),
    place,
  );
  it("is false for title/notes/group edits and true for destination, timing, purpose", () => {
    expect(factsInputsChanged(row, { ...write, title: "x", notes: "y", group_id: "g" })).toBe(false);
    expect(factsInputsChanged(row, { ...write, dest_geo_id: 1 })).toBe(true);
    expect(factsInputsChanged(row, { ...write, months: [4] })).toBe(true);
    expect(factsInputsChanged(row, { ...write, purpose_id: "p" })).toBe(true);
  });
});

import { normalizeCountryCode as _ncc } from "./trip-mapping";
describe("normalizeCountryCode", () => {
  it("uppercases valid codes and nulls invalid ones", () => {
    expect(_ncc("de")).toBe("DE");
    expect(_ncc("DEU")).toBeNull();
    expect(_ncc("")).toBeNull();
    expect(_ncc(null)).toBeNull();
  });
});

describe("one-off group (spec group-text)", () => {
  const free = { destination: { kind: "freetext" as const, name: "Irgendwo" }, lengthDays: 3 };
  const text = "Ich und Ben, ähnliches Alter";

  it("is exclusive with a saved group in the schema", () => {
    const gid = "22222222-2222-4222-8222-222222222222";
    expect(TripInput.safeParse({ ...free, groupId: gid, groupText: text }).success).toBe(false);
    expect(TripInput.safeParse({ ...free, groupId: gid }).success).toBe(true);
    expect(TripInput.safeParse({ ...free, groupText: text }).success).toBe(true);
    expect(TripInput.safeParse({ ...free }).success).toBe(true); // all context optional
  });

  it("a structure needs the text", () => {
    const entry = { kind: "composition" as const, count: 2 };
    expect(TripInput.safeParse({ ...free, groupStructure: [entry] }).success).toBe(false);
    expect(TripInput.safeParse({ ...free, groupText: text, groupStructure: [entry] }).success).toBe(true);
  });

  it("writes text and structure; a saved group clears them", () => {
    const entry = { kind: "composition" as const, count: 2, age: { ageMode: "exact" as const, age: 41 }, label: "Freunde" };
    const w = buildTripWrite(TripInput.parse({ ...free, groupText: text, groupStructure: [entry] }), null, { today: "2026-10-29" });
    expect(w.group_id).toBeNull();
    expect(w.group_text).toBe(text);
    expect(w.group_structure).toEqual([{ count: 2, label: "Freunde", age: { ageMode: "exact", age: 41 }, ageAsOf: "2026-10-29" }]);
    const gid = "22222222-2222-4222-8222-222222222222";
    const saved = buildTripWrite({ ...TripInput.parse({ ...free, groupId: gid }), groupText: text }, null);
    expect(saved).toMatchObject({ group_id: gid, group_text: null, group_structure: null });
    expect(buildTripWrite(TripInput.parse(free), null)).toMatchObject({ group_text: null, group_structure: null });
  });

  it("keeps the old ageAsOf when the stated age did not change, resets it otherwise", () => {
    const existing = { group_structure: [{ count: 2, age: { ageMode: "exact", age: 41 }, ageAsOf: "2026-01-05" }] };
    const same = TripInput.parse({ ...free, groupText: text, groupStructure: [{ kind: "composition", count: 3, age: { ageMode: "exact", age: 41 } }] });
    expect((buildTripWrite(same, null, { today: "2026-10-29", existing }).group_structure as { ageAsOf: string }[])[0].ageAsOf).toBe("2026-01-05");
    const changed = TripInput.parse({ ...free, groupText: text, groupStructure: [{ kind: "composition", count: 3, age: { ageMode: "exact", age: 42 } }] });
    expect((buildTripWrite(changed, null, { today: "2026-10-29", existing }).group_structure as { ageAsOf: string }[])[0].ageAsOf).toBe("2026-10-29");
    const relative = TripInput.parse({ ...free, groupText: text, groupStructure: [{ kind: "composition", count: 2, age: { ageMode: "relativeToMe" } }] });
    expect(buildTripWrite(relative, null, { today: "2026-10-29" }).group_structure).toEqual([{ count: 2, age: { ageMode: "relativeToMe" } }]);
  });

  it("the cached parse is only used for the exact text it belongs to", () => {
    const parse = { v: 1, travellers: [{ count: 2 }], notes: [] };
    const base = { ...row, group_text: text, group_parsed: parse, group_parsed_hash: groupTextHash(text) };
    expect(rowToTrip(base).groupParse).toEqual(parse);
    expect(rowToTrip({ ...base, group_text: text + " und Oma" }).groupParse).toBeUndefined(); // text changed: stale
    expect(rowToTrip({ ...base, group_parsed_hash: null }).groupParse).toBeUndefined();
    expect(rowToTrip({ ...base, group_parsed: { v: 2 } }).groupParse).toBeUndefined(); // invalid shape
    expect(rowToTrip({ ...base, group_text: `  ${text}\n` }).groupParse).toEqual(parse); // whitespace-insensitive
  });

  it("reads a stored structure and ignores a broken one", () => {
    const ok = [{ count: 2, age: { ageMode: "approx", age: 40 }, ageAsOf: "2026-10-29" }];
    expect(rowToTrip({ ...row, group_text: text, group_structure: ok }).groupStructure).toEqual(ok);
    expect(rowToTrip({ ...row, group_text: text, group_structure: [{ count: 0 }] }).groupStructure).toEqual([]);
    expect(rowToTrip(row).groupStructure).toEqual([]);
  });
});
