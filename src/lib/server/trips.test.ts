import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Result = { data?: unknown; error?: { code: string } | null; count?: number | null };
const h = vi.hoisted(() => ({
  results: {} as Record<string, Result>, // key: `${table}.${op}`
  ops: [] as { table: string; op: string; payload?: unknown }[],
  session: true as boolean,
  getPlaceById: vi.fn(),
  warm: vi.fn(),
  logEvent: vi.fn(),
  ensureParse: vi.fn(async () => false),
  afterFns: [] as (() => Promise<void>)[],
}));

function builder(table: string) {
  let op = "select";
  let payload: unknown;
  const b: Record<string, unknown> = {};
  const settle = (): Result => {
    h.ops.push({ table, op, payload });
    return { data: null, error: null, count: null, ...(h.results[`${table}.${op}`] ?? {}) };
  };
  for (const m of ["select", "eq", "order", "returns"]) b[m] = () => b;
  b.insert = (p: unknown) => { op = "insert"; payload = p; return b; };
  b.update = (p: unknown) => { op = "update"; payload = p; return b; };
  b.delete = () => { op = "delete"; return b; };
  b.single = async () => settle();
  b.maybeSingle = async () => settle();
  b.then = (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(settle()).then(res, rej);
  return b;
}

vi.mock("./session", () => ({
  getUserSession: async () =>
    h.session ? { userId: "u1", supabase: { from: (t: string) => builder(t) } } : null,
}));
vi.mock("./events", () => ({ logEvent: h.logEvent }));
vi.mock("./facts", () => ({ warmTripFacts: h.warm }));
vi.mock("./group-text", () => ({ ensureGroupParse: h.ensureParse }));
vi.mock("./purposes", () => ({ getPurpose: async () => ({ ok: false, error: "not_found" }) }));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => h.afterFns.push(fn) }));
vi.mock("@/lib/integrations/open-meteo-geocoding", () => ({ getPlaceById: h.getPlaceById }));

import { createTrip, deleteTrip, getTrip, listTrips, updateTrip } from "./trips";

const place = {
  geoId: 2513918, name: "Marbella", featureCode: "PPLA3", countryCode: "ES", admin1: "Andalusia",
  lat: 36.51, lon: -4.88, timezone: "Europe/Madrid", population: 1, suggestedKind: "city" as const,
};
const row = {
  id: "11111111-1111-4111-8111-111111111111", title: null, dest_kind: "city", dest_name: "Marbella",
  dest_place_name: "Marbella", dest_geo_id: 2513918, dest_country_code: "ES", dest_admin1: "Andalusia",
  dest_lat: 36.51, dest_lon: -4.88, dest_timezone: "Europe/Madrid", dest_radius_km: null, length_days: 5,
  start_date: null, months: [], group_id: null, group_text: null, group_structure: null, group_parsed: null,
  group_parsed_hash: null, purpose_id: null, wants_flights: true, origin_airports: [],
  notes: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};
const input = { destination: { kind: "city" as const, geoId: 2513918 }, lengthDays: 5 };

beforeEach(() => {
  h.results = { "profiles.select": { data: { locale: "en" } } };
  h.ops = [];
  h.session = true;
  h.afterFns = [];
  h.getPlaceById.mockReset().mockResolvedValue(place);
  h.warm.mockReset();
  h.logEvent.mockReset();
});

describe("createTrip", () => {
  it("requires a session", async () => {
    h.session = false;
    expect(await createTrip(input)).toEqual({ ok: false, error: "unauthenticated" });
  });

  it("rejects invalid input and unknown airports without touching the DB", async () => {
    expect(await createTrip({ ...input, lengthDays: 61 })).toMatchObject({ ok: false, error: "invalid" });
    expect(await createTrip({ ...input, originAirports: ["ZZZ"] })).toEqual({ ok: false, error: "unknown_airport" });
    expect(h.ops).toHaveLength(0);
  });

  it("limit_reached at 30 trips", async () => {
    h.results["trips.select"] = { count: 30 };
    expect(await createTrip(input)).toEqual({ ok: false, error: "limit_reached" });
    expect(h.ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("unknown_place when the geoId cannot be resolved; failed when the lookup throws", async () => {
    h.getPlaceById.mockResolvedValue(null);
    expect(await createTrip(input)).toEqual({ ok: false, error: "unknown_place" });
    h.getPlaceById.mockRejectedValue(new Error("down"));
    expect(await createTrip(input)).toEqual({ ok: false, error: "failed" });
  });

  it("stores server-resolved coordinates, logs a PII-free event, schedules warming", async () => {
    h.results["trips.select"] = { count: 0, data: row };
    h.results["trips.insert"] = { data: row };
    const res = await createTrip({
      ...input,
      title: "Secret title",
      notes: "secret notes",
      destination: { kind: "city", geoId: 2513918, name: "Home sweet" },
    });
    expect(res).toMatchObject({ ok: true, data: { id: row.id } });
    expect(h.getPlaceById).toHaveBeenCalledWith(2513918, "en");
    const insert = h.ops.find((o) => o.op === "insert")!.payload as Record<string, unknown>;
    expect(insert).toMatchObject({ dest_lat: 36.51, dest_lon: -4.88, dest_timezone: "Europe/Madrid", dest_name: "Home sweet" });
    expect(insert).not.toHaveProperty("owner_id");
    const ev = h.logEvent.mock.calls[0][0];
    expect(ev.event).toBe("trip.created");
    expect(JSON.stringify(ev)).not.toMatch(/Secret|secret|Marbella/);
    expect(Object.keys(ev.props).sort()).toEqual(
      ["destKind", "hasGroup", "hasGroupText", "hasPurpose", "lengthDays", "timingKind", "tripId"],
    );
    expect(h.afterFns).toHaveLength(1);
    await h.afterFns[0]();
    expect(h.warm).toHaveBeenCalledOnce();
  });

  it("maps a foreign key violation (other user's group) to not_found", async () => {
    h.results["trips.select"] = { count: 0 };
    h.results["trips.insert"] = { error: { code: "23503" } };
    expect(await createTrip(input)).toEqual({ ok: false, error: "not_found" });
    h.results["trips.insert"] = { error: { code: "XX000" } };
    expect(await createTrip(input)).toEqual({ ok: false, error: "failed" });
  });

  it("freetext needs no geocoding", async () => {
    h.results["trips.select"] = { count: 0 };
    h.results["trips.insert"] = { data: { ...row, dest_kind: "freetext", dest_geo_id: null, dest_lat: null, dest_lon: null } };
    const res = await createTrip({ destination: { kind: "freetext", name: "Alpen" }, lengthDays: 2 });
    expect(res.ok).toBe(true);
    expect(h.getPlaceById).not.toHaveBeenCalled();
  });
});

describe("one-off group of the trip", () => {
  const text = "Ich und Ben, ähnliches Alter";
  it("stores the text, parses once and reloads the row", async () => {
    h.results["trips.select"] = { count: 0, data: { ...row, group_text: text } };
    h.results["trips.insert"] = { data: { ...row, group_text: text } };
    h.ensureParse.mockResolvedValueOnce(true);
    const res = await createTrip({ ...input, groupText: text });
    expect(res).toMatchObject({ ok: true, data: { groupText: text, groupId: null } });
    const insert = h.ops.find((o) => o.table === "trips" && o.op === "insert")!.payload as Record<string, unknown>;
    expect(insert).toMatchObject({ group_id: null, group_text: text, group_structure: null });
    expect(h.ensureParse).toHaveBeenCalledWith(expect.anything(), { table: "trips", id: row.id }, text, false);
  });

  it("a saved group wins over stray text: no text is stored", async () => {
    const gid = "22222222-2222-4222-8222-222222222222";
    const res = await createTrip({ ...input, groupId: gid, groupText: text });
    expect(res).toMatchObject({ ok: false, error: "invalid" }); // exclusive in the schema
  });

  it("does not call Haiku without text", async () => {
    h.results["trips.select"] = { count: 0 };
    h.results["trips.insert"] = { data: row };
    await createTrip(input);
    expect(h.ensureParse).not.toHaveBeenCalled();
  });

  it("stores the corrected structure with ageAsOf", async () => {
    h.results["trips.select"] = { count: 0 };
    h.results["trips.insert"] = { data: { ...row, group_text: text } };
    await createTrip({
      ...input,
      groupText: text,
      groupStructure: [{ kind: "composition", count: 2, age: { ageMode: "approx", age: 40 } }],
    });
    const insert = h.ops.find((o) => o.table === "trips" && o.op === "insert")!.payload as { group_structure: { ageAsOf?: string }[] };
    expect(insert.group_structure[0]).toMatchObject({ count: 2, age: { ageMode: "approx", age: 40 } });
    expect(insert.group_structure[0].ageAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("updateTrip / getTrip / deleteTrip / listTrips", () => {
  it("updateTrip: not_found when the row is invisible; no warming for a title-only change", async () => {
    expect(await updateTrip(row.id, input)).toEqual({ ok: false, error: "not_found" });
    h.results["trips.select"] = { data: row };
    h.results["trips.update"] = { data: { ...row, title: "New" } };
    const res = await updateTrip(row.id, { ...input, title: "New" });
    expect(res).toMatchObject({ ok: true, data: { title: "New" } });
    expect(h.getPlaceById).not.toHaveBeenCalled(); // same geoId: stored coordinates reused
    expect(h.afterFns).toHaveLength(0);
    expect(h.logEvent.mock.calls[0][0].event).toBe("trip.updated");
  });

  it("updateTrip: changed destination resolves again and warms", async () => {
    h.results["trips.select"] = { data: row };
    h.results["trips.update"] = { data: row };
    h.getPlaceById.mockResolvedValue({ ...place, geoId: 999 });
    await updateTrip(row.id, { ...input, destination: { kind: "city", geoId: 999 } });
    expect(h.getPlaceById).toHaveBeenCalledWith(999, "en");
    expect(h.afterFns).toHaveLength(1);
  });

  it("rejects non-uuid ids", async () => {
    expect(await getTrip("nope")).toMatchObject({ ok: false, error: "invalid" });
    expect(await deleteTrip("nope")).toMatchObject({ ok: false, error: "invalid" });
    expect(await updateTrip("nope", input)).toMatchObject({ ok: false, error: "invalid" });
  });

  it("getTrip maps the row", async () => {
    h.results["trips.select"] = { data: row };
    expect(await getTrip(row.id)).toMatchObject({ ok: true, data: { destination: { kind: "city", radiusKm: 15 } } });
    h.results["trips.select"] = { data: null };
    expect(await getTrip(row.id)).toEqual({ ok: false, error: "not_found" });
  });

  it("deleteTrip: not_found on 0 rows, event on success", async () => {
    h.results["trips.delete"] = { data: [] };
    expect(await deleteTrip(row.id)).toEqual({ ok: false, error: "not_found" });
    h.results["trips.delete"] = { data: [{ id: row.id }] };
    expect(await deleteTrip(row.id)).toEqual({ ok: true });
    expect(h.logEvent.mock.calls[0][0]).toMatchObject({ event: "trip.deleted", props: { tripId: row.id } });
  });

  it("listTrips embeds group and purpose names", async () => {
    h.results["trips.select"] = { data: [{ ...row, travel_groups: { name: "G" }, trip_purposes: null }] };
    const res = await listTrips();
    expect(res).toMatchObject({ ok: true, data: [{ groupName: "G", purposeName: null }] });
  });
});
