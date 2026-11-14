import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { Op, Reply } from "./tour/test-db";

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  reply: (() => ({})) as (op: Op) => Reply,
  session: true,
  logEvent: vi.fn(),
  getPlaceById: vi.fn(),
  cityPlaces: vi.fn(),
  getPurpose: vi.fn(),
}));
vi.mock("./session", async () => {
  const { fakeDb } = await import("./tour/test-db");
  return { getUserSession: async () => (h.session ? { userId: "u1", supabase: fakeDb("user", h.ops, (o) => h.reply(o)) } : null) };
});
vi.mock("./events", () => ({ logEvent: h.logEvent }));
vi.mock("@/lib/integrations/open-meteo-geocoding", () => ({ getPlaceById: h.getPlaceById }));
vi.mock("./facts/place-search", () => ({ placeDetails: async () => null }));
vi.mock("./purposes", () => ({ getPurpose: h.getPurpose }));
vi.mock("./tour/places", async (orig) => ({ ...(await orig<typeof import("./tour/places")>()), cityPlaces: h.cityPlaces }));

import { TourInput } from "@/lib/domain/tour";
import { resetRateLimits } from "./rate-limit";
import { signPointRef, verifyPointRef } from "./tour/point-ref";
import { createTour, deleteTour, getTour, linkTourToTrip, listTours, tourSuggestions, updateTour } from "./tours";

const TOUR = "11111111-1111-4111-8111-111111111111";
const TRIP = "22222222-2222-4222-8222-222222222222";
const osm = (id: number) => ({ key: `osm:n${id}`, name: `P${id}`, lat: 48.2 + id / 1000, lon: 16.37, source: "osm" as const });
const signed = (id: number) => ({ key: `osm:n${id}`, ref: signPointRef(osm(id)) });
const draft = () => ({ places: [signed(1), signed(2)] });
const input = TourInput.parse({ places: [osm(1), osm(2)] });
const row = (over: Record<string, unknown> = {}) => ({
  id: TOUR, owner_id: "u1", title: null, input, trip_id: null, trip_day: null, result: null, result_hash: null,
  computed_at: null, created_at: "2026-11-12T00:00:00Z", updated_at: "2026-11-12T00:00:00Z", ...over,
});
const writes = () => h.ops.filter((o) => o.op !== "select");

beforeEach(() => {
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
  resetRateLimits();
  h.ops = [];
  h.session = true;
  h.logEvent.mockReset();
  h.getPlaceById.mockReset();
  h.cityPlaces.mockReset();
  h.getPurpose.mockReset();
  h.reply = (o) => {
    if (o.table === "profiles") return { data: { locale: "de" } };
    if (o.table === "city_tours" && o.head) return { count: 0 };
    if (o.table === "city_tours" && o.op === "insert") return { data: row({ input: (o.payload as { input: unknown }).input }) };
    if (o.table === "city_tours") return { data: row() };
    return {};
  };
});
afterEach(() => vi.unstubAllEnvs());

describe("createTour", () => {
  it("requires a session and a valid draft", async () => {
    expect(await createTour({ places: [signed(1)] })).toMatchObject({ ok: false, error: "invalid" });
    h.session = false;
    expect(await createTour(draft())).toEqual({ ok: false, error: "unauthenticated" });
  });

  it("stores server-resolved points; never sends owner_id or the result columns", async () => {
    const res = await createTour({ places: [{ ...signed(1), dwellMin: 60 }, signed(2)], mode: "car", route: "no_highways" });
    expect(res.ok).toBe(true);
    const insert = writes()[0];
    expect(insert.table).toBe("city_tours");
    expect(Object.keys(insert.payload as object).sort()).toEqual(["input", "title", "trip_day", "trip_id"]);
    expect((insert.payload as { input: TourInput }).input.places).toEqual([{ ...osm(1), dwellMin: 60 }, osm(2)]);
    expect(h.logEvent).toHaveBeenCalledWith({
      event: "tour.created",
      userId: "u1",
      props: { places: 2, mode: "car", route: "no_highways", order: "optimize", hasCity: false, hasStart: false, hasTime: false, linked: false },
    });
  });

  it("rejects an unknown point key (no reference) before writing", async () => {
    const res = await createTour({ places: [signed(1), { key: "osm:n2" }] });
    expect(res).toMatchObject({ ok: false, error: "unknown_point", issues: [{ path: "osm:n2" }] });
    expect(writes()).toHaveLength(0);
  });

  it("caps at 50 own tours (shared ones do not count)", async () => {
    const base = h.reply;
    h.reply = (o) => (o.table === "city_tours" && o.head ? { count: 50 } : base(o));
    expect(await createTour(draft())).toEqual({ ok: false, error: "limit_reached" });
    const count = h.ops.find((o) => o.head)!;
    expect(count.eqs).toContainEqual(["owner_id", "u1"]);
    expect(writes()).toHaveLength(0);
  });

  it("rate limits writes (30 per minute)", async () => {
    for (let i = 0; i < 30; i++) await createTour(draft());
    expect(await createTour(draft())).toEqual({ ok: false, error: "rate_limited" });
  });

  it("links on create only to an own trip and a day within its length", async () => {
    const base = h.reply;
    h.reply = (o) => (o.table === "trips" ? { data: { id: TRIP, owner_id: "u2", length_days: 5 } } : base(o));
    expect(await createTour(draft(), { tripId: TRIP, day: 2 })).toEqual({ ok: false, error: "forbidden" });
    h.reply = (o) => (o.table === "trips" ? { data: { id: TRIP, owner_id: "u1", length_days: 5 } } : base(o));
    expect(await createTour(draft(), { tripId: TRIP, day: 6 })).toEqual({ ok: false, error: "invalid" });
    expect((await createTour(draft(), { tripId: TRIP, day: 2 })).ok).toBe(true);
    expect(writes().at(-1)!.payload).toMatchObject({ trip_id: TRIP, trip_day: 2 });
  });
});

describe("updateTour / deleteTour / linkTourToTrip: owner only", () => {
  const grantee = () => {
    const base = h.reply;
    h.reply = (o) => (o.table === "city_tours" && o.op === "select" ? { data: row({ owner_id: "u2", trip_id: TRIP }) } : base(o));
  };

  it("a grantee of the linked trip reads the tour (access read) but cannot update, delete or link it", async () => {
    grantee();
    expect(await getTour(TOUR)).toMatchObject({ ok: true, data: { access: "read", ownerId: "u2" } });
    expect(await updateTour(TOUR, draft())).toEqual({ ok: false, error: "forbidden" });
    expect(await deleteTour(TOUR)).toEqual({ ok: false, error: "forbidden" });
    expect(await linkTourToTrip(TOUR, null, null)).toEqual({ ok: false, error: "forbidden" });
    expect(writes()).toHaveLength(0);
  });

  it("update keeps stored points without a reference and never writes result columns", async () => {
    const res = await updateTour(TOUR, { title: " Domrunde ", places: [{ key: "osm:n1", dwellMin: 5 }, { key: "osm:n2" }] }, "2026-11-12T00:00:00Z");
    expect(res.ok).toBe(true);
    const upd = writes()[0];
    expect(Object.keys(upd.payload as object).sort()).toEqual(["input", "title"]);
    expect(upd.payload).toMatchObject({ title: "Domrunde", input: { places: [{ ...osm(1), dwellMin: 5 }, osm(2)] } });
    expect(upd.eqs).toEqual([["id", TOUR], ["owner_id", "u1"], ["updated_at", "2026-11-12T00:00:00Z"]]);
  });

  it("update: conflict on a stale form, unknown new point rejected", async () => {
    expect(await updateTour(TOUR, draft(), "2020-01-01T00:00:00Z")).toEqual({ ok: false, error: "conflict" });
    expect(await updateTour(TOUR, { places: [{ key: "osm:n1" }, { key: "osm:n77" }] })).toMatchObject({ ok: false, error: "unknown_point" });
    expect(writes()).toHaveLength(0);
  });

  it("the update is conditional on the loaded version: a concurrent save in between → conflict", async () => {
    const base = h.reply;
    h.reply = (o) => (o.op === "update" ? { data: null } : base(o));
    expect(await updateTour(TOUR, draft(), "2026-11-12T00:00:00Z")).toEqual({ ok: false, error: "conflict" });
    expect(writes()[0].eqs).toContainEqual(["updated_at", "2026-11-12T00:00:00Z"]);
  });

  it("a returned 0-row update or delete is not_found", async () => {
    const base = h.reply;
    h.reply = (o) => (o.op === "update" ? { data: null } : o.op === "delete" ? { data: [] } : base(o));
    expect(await updateTour(TOUR, draft())).toEqual({ ok: false, error: "not_found" });
    expect(await deleteTour(TOUR)).toEqual({ ok: false, error: "not_found" });
  });

  it("linking to another owner's trip: refused; the composite FK (23503) maps to not_found", async () => {
    const base = h.reply;
    h.reply = (o) => (o.table === "trips" ? { data: { id: TRIP, owner_id: "u2", length_days: 5 } } : base(o));
    expect(await linkTourToTrip(TOUR, TRIP, 1)).toEqual({ ok: false, error: "forbidden" });
    h.reply = (o) =>
      o.table === "trips" ? { data: { id: TRIP, owner_id: "u1", length_days: 5 } } : o.op === "update" ? { error: { code: "23503" } } : base(o);
    expect(await linkTourToTrip(TOUR, TRIP, 1)).toEqual({ ok: false, error: "not_found" });
  });

  it("link and unlink log tour.linked without ids or names", async () => {
    const base = h.reply;
    h.reply = (o) => (o.table === "trips" ? { data: { id: TRIP, owner_id: "u1", length_days: 5 } } : base(o));
    expect((await linkTourToTrip(TOUR, TRIP, 3)).ok).toBe(true);
    expect(writes()[0].payload).toEqual({ trip_id: TRIP, trip_day: 3 });
    expect((await linkTourToTrip(TOUR, null, null)).ok).toBe(true);
    expect(h.logEvent.mock.calls.map((c) => c[0].props)).toEqual([{ linked: true, hasDay: true }, { linked: false, hasDay: false }]);
    expect(await linkTourToTrip(TOUR, null, 2)).toEqual({ ok: false, error: "invalid" });
  });
});

describe("listTours / getTour", () => {
  it("lists own tours only and marks results without a matching hash as outdated", async () => {
    const base = h.reply;
    h.reply = (o) => (o.table === "city_tours" ? { data: [row(), row({ input: { junk: true } })] } : base(o));
    const res = await listTours();
    expect(res.ok && res.data).toEqual([expect.objectContaining({ id: TOUR, placeCount: 2, outdated: true, access: "owner" })]);
    expect(h.ops[0].eqs).toContainEqual(["owner_id", "u1"]);
  });
});

describe("tourSuggestions", () => {
  const wien = { geoId: 2761369, name: "Wien", featureCode: "PPLC", countryCode: "AT", admin1: null, lat: 48.20849, lon: 16.37208, timezone: "Europe/Vienna", population: 1, suggestedKind: "city" };
  it("offers cached city places with references the actions accept", async () => {
    h.getPlaceById.mockResolvedValue(wien);
    h.cityPlaces.mockResolvedValue({
      places: [{ key: "osm:w212496461", name: "Stephansdom", lat: 48.2085, lon: 16.3731, cat: "place_of_worship", url: "u" }],
      pending: false,
      fetchedAt: "2026-11-01T00:00:00Z",
    });
    const res = await tourSuggestions({ city: "geo:2761369" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const s = res.data.suggestions[0];
    expect(verifyPointRef(s.ref, s.key)?.p).toEqual({ key: s.key, name: "Stephansdom", lat: 48.2085, lon: 16.3731, source: "osm", cat: "place_of_worship" });
    expect(h.cityPlaces.mock.calls[0][1]).toEqual(["general"]);
  });

  it("adds the linked trip's purpose interests; rejects a non-geo city key", async () => {
    h.getPlaceById.mockResolvedValue(wien);
    h.cityPlaces.mockResolvedValue({ places: [], pending: true, fetchedAt: null });
    const base = h.reply;
    h.reply = (o) => (o.table === "trips" ? { data: { purpose_id: "33333333-3333-4333-8333-333333333333" } } : base(o));
    h.getPurpose.mockResolvedValue({ ok: true, data: { guided: { interests: ["architecture"] }, tags: null } });
    const res = await tourSuggestions({ city: "geo:2761369", tripId: TRIP });
    expect(res).toMatchObject({ ok: true, data: { pending: true } });
    expect(h.cityPlaces.mock.calls[0][1]).toEqual(["general", "architecture"]);
    expect(await tourSuggestions({ city: "osm:n1" })).toMatchObject({ ok: false, error: "invalid" });
  });
});
