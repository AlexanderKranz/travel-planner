import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ getPlaceById: vi.fn(), placeDetails: vi.fn() }));
vi.mock("@/lib/integrations/open-meteo-geocoding", () => ({ getPlaceById: h.getPlaceById }));
vi.mock("../facts/place-search", () => ({ placeDetails: h.placeDetails }));

import { TourDraft, TourInput } from "@/lib/domain/tour";
import { signPointRef } from "./point-ref";
import { knownPoints, resolveDraft } from "./resolve";

const ctx = { userId: "u1" };
const osm = (id: number, lat = 48.2, lon = 16.37) => ({ key: `osm:n${id}`, name: `P${id}`, lat, lon, source: "osm" as const });
const draftOf = (p: { key: string }) => ({ key: p.key, ref: signPointRef(p as never) });
const parse = (d: unknown) => TourDraft.parse(d);
const wien = { geoId: 2761369, name: "Wien", featureCode: "PPLC", countryCode: "AT", admin1: null, lat: 48.20849, lon: 16.37208, timezone: "Europe/Vienna", population: 1, suggestedKind: "city" };

beforeEach(() => {
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
  h.getPlaceById.mockReset().mockResolvedValue(wien);
  h.placeDetails.mockReset().mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("resolveDraft: the browser never supplies coordinates", () => {
  it("takes every value of a signed point from the reference, not from the request", async () => {
    const a = osm(1);
    const b = osm(2, 48.21, 16.38);
    const r = await resolveDraft(parse({ places: [{ ...draftOf(a), dwellMin: 45 }, draftOf(b)] }), new Map(), "de", ctx);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.input.places).toEqual([{ ...a, dwellMin: 45 }, b]);
  });

  it("rejects an unknown key (no ref, not stored, not geo:)", async () => {
    const r = await resolveDraft(parse({ places: [draftOf(osm(1)), { key: "osm:n999" }] }), new Map(), "de", ctx);
    expect(r).toEqual({ ok: false, error: "unknown_point", keys: ["osm:n999"] });
  });

  it("rejects a reference signed for another key", async () => {
    const a = osm(1);
    const r = await resolveDraft(parse({ places: [draftOf(a), { key: "osm:n2", ref: draftOf(a).ref }] }), new Map(), "de", ctx);
    expect(r).toEqual({ ok: false, error: "unknown_point", keys: ["osm:n2"] });
  });

  it("accepts points already stored in the tour and sights of its stored result without a reference", async () => {
    const stored = TourInput.parse({ places: [osm(1), osm(2)] });
    const sight = { key: "osm:w7", name: "Karlskirche", lat: 48.198, lon: 16.371, leg: 0, m: 40, cat: "place_of_worship" };
    const known = knownPoints(stored, { v: 1, order: [], legs: [], totalMin: null, fit: "none", sights: [sight], source: { ors: "x" } });
    const r = await resolveDraft(parse({ places: [{ key: "osm:n1", dwellMin: 10 }, { key: "osm:w7" }] }), known, "de", ctx);
    expect(r.ok && r.input.places).toEqual([
      { ...osm(1), dwellMin: 10 },
      { key: "osm:w7", name: "Karlskirche", lat: 48.198, lon: 16.371, source: "osm", cat: "place_of_worship" },
    ]);
  });

  it("resolves geo: keys by GeoNames id (city, start, end); unknown id and provider errors", async () => {
    const r = await resolveDraft(
      parse({ city: { key: "geo:2761369" }, places: [draftOf(osm(1)), draftOf(osm(2))], start: { key: "geo:2761369" }, end: "start" }),
      new Map(),
      "en",
      ctx,
    );
    expect(r.ok && r.input.city).toEqual({ key: "geo:2761369", name: "Wien", lat: 48.20849, lon: 16.37208, source: "geonames" });
    expect(h.getPlaceById).toHaveBeenCalledWith(2761369, "en");
    h.getPlaceById.mockResolvedValue(null);
    expect(await resolveDraft(parse({ city: { key: "geo:1" }, places: [draftOf(osm(1)), draftOf(osm(2))] }), new Map(), "de", ctx)).toEqual({
      ok: false,
      error: "unknown_point",
      keys: ["geo:1"],
    });
    h.getPlaceById.mockRejectedValue(new Error("down"));
    expect(await resolveDraft(parse({ city: { key: "geo:1" }, places: [draftOf(osm(1)), draftOf(osm(2))] }), new Map(), "de", ctx)).toEqual({
      ok: false,
      error: "failed",
    });
  });

  it("an OSM search result is resolved once to its osm: key; overrides follow the new key", async () => {
    const g = { key: "gfy:0123456789abcdef0123456789abcdef", name: "Stephansdom", lat: 48.2085, lon: 16.3731, source: "geoapify" as const };
    const ref = signPointRef(g, { id: "51abc0def1234567", osm: true });
    h.placeDetails.mockResolvedValue({ osmKey: "osm:w212496461", name: "Stephansdom", lat: 48.20853, lon: 16.37318, cat: "place_of_worship", fetchedAt: "f" });
    const b = osm(2);
    const r = await resolveDraft(
      parse({ places: [{ key: g.key, ref }, draftOf(b)], legOverrides: { [`${g.key}>osm:n2`]: { mode: "car", route: "fastest" }, "x>y": { mode: "car", route: "fastest" } } }),
      new Map(),
      "de",
      ctx,
    );
    expect(h.placeDetails).toHaveBeenCalledWith("51abc0def1234567", "de", ctx);
    expect(r.ok && r.input.places[0]).toEqual({ key: "osm:w212496461", name: "Stephansdom", lat: 48.20853, lon: 16.37318, source: "osm", cat: "place_of_worship" });
    expect(r.ok && r.input.legOverrides).toEqual({ "osm:w212496461>osm:n2": { mode: "car", route: "fastest" } });
  });

  it("details unavailable or a non-OSM result: the point stays gfy: with its signed coordinates", async () => {
    const g = { key: "gfy:0123456789abcdef0123456789abcdef", name: "Hotel", lat: 48.2, lon: 16.3, source: "geoapify" as const };
    const r = await resolveDraft(parse({ places: [{ key: g.key, ref: signPointRef(g, { id: "51abc0def1234567", osm: true }) }, draftOf(osm(2))] }), new Map(), "de", ctx);
    expect(r.ok && r.input.places[0]).toEqual(g);
    h.placeDetails.mockClear();
    await resolveDraft(parse({ places: [{ key: g.key, ref: signPointRef(g, { id: "51abc0def1234567", osm: false }) }, draftOf(osm(2))] }), new Map(), "de", ctx);
    expect(h.placeDetails).not.toHaveBeenCalled();
  });

  it("two results that resolve to the same place are a duplicate (invalid)", async () => {
    const g1 = { key: "gfy:00000000000000000000000000000001", name: "A", lat: 48.2, lon: 16.3, source: "geoapify" as const };
    const g2 = { ...g1, key: "gfy:00000000000000000000000000000002" };
    h.placeDetails.mockResolvedValue({ osmKey: "osm:n5", name: "A", lat: 48.2, lon: 16.3, fetchedAt: "f" });
    const r = await resolveDraft(
      parse({ places: [{ key: g1.key, ref: signPointRef(g1, { id: "51a0000000000000", osm: true }) }, { key: g2.key, ref: signPointRef(g2, { id: "51b0000000000000", osm: true }) }] }),
      new Map(),
      "de",
      ctx,
    );
    expect(r).toMatchObject({ ok: false, error: "invalid" });
  });
});
