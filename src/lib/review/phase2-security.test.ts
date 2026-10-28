import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { TripInput, DestinationInput } from "@/lib/domain/trip";
import { buildTripWrite } from "@/lib/server/trip-mapping";
import { buildQuery } from "@/lib/integrations/overpass";
import { INTEREST_SOURCES, MAX_RADIUS_KM, radiusForInterest, interestsForTrip } from "@/lib/facts/interest-sources";
import { cacheKey } from "@/lib/server/api-cache";
import { userAgent } from "@/lib/integrations/http";

describe("coordinates never come from the client", () => {
  it("TripInput strips client-sent lat/lon/timezone on geocoded destinations", () => {
    const p = TripInput.parse({
      destination: { kind: "city", geoId: 1, lat: 1, lon: 2, timezone: "X/Y", placeName: "evil", countryCode: "XX" },
      lengthDays: 3,
    });
    expect(p.destination).not.toHaveProperty("lat");
    expect(p.destination).not.toHaveProperty("lon");
    expect(p.destination).not.toHaveProperty("timezone");
    expect(p.destination).not.toHaveProperty("countryCode");
  });
  it("freetext with coordinates never writes them", () => {
    const p = TripInput.parse({ destination: { kind: "freetext", name: "x", lat: 5, lon: 5 }, lengthDays: 3 });
    const w = buildTripWrite(p, { geoId: 1, name: "n", featureCode: "", countryCode: "DE", admin1: null, lat: 9, lon: 9, timezone: null, population: null, suggestedKind: "city" });
    expect(w.dest_lat).toBeNull();
    expect(w.dest_lon).toBeNull();
    expect(w.dest_geo_id).toBeNull();
  });
  it("geocoded write uses only the server-resolved place", () => {
    const p = TripInput.parse({ destination: { kind: "city", geoId: 1, name: "Mine" }, lengthDays: 3 });
    const w = buildTripWrite(p, { geoId: 1, name: "Real", featureCode: "PPL", countryCode: "DE", admin1: "B", lat: 48.5, lon: 13.4, timezone: "Europe/Berlin", population: 1, suggestedKind: "city" });
    expect([w.dest_lat, w.dest_lon, w.dest_place_name, w.dest_name]).toEqual([48.5, 13.4, "Real", "Mine"]);
  });
  it("geoId rejects non-integers, zero, negatives, NaN-ish", () => {
    for (const geoId of [0, -1, 1.5, Number.NaN, Infinity, "1", null]) {
      expect(DestinationInput.safeParse({ kind: "city", geoId }).success, String(geoId)).toBe(false);
    }
  });
  it("geoId must be a safe integer (huge values are rejected)", () => {
    expect(DestinationInput.safeParse({ kind: "city", geoId: 1e21 }).success).toBe(false);
  });
  it("radiusKm is bounded 1..200 by Zod", () => {
    for (const radiusKm of [0, 201, -5, 1.5]) {
      expect(DestinationInput.safeParse({ kind: "region", geoId: 1, radiusKm }).success).toBe(false);
    }
  });
});

describe("Overpass query construction", () => {
  const center = { lat: 36.51543, lon: -4.88583 };
  it("only static filters and numbers reach the query text", () => {
    for (const s of Object.values(INTEREST_SOURCES)) {
      if (s.source !== "osm") continue;
      const q = buildQuery(s.filters, center, 40_000);
      expect(q).toMatch(/^\[out:json\]\[timeout:25\];\n\(\n(  nwr.*;\n)+\);\nout center tags 150;$/);
      expect(q).not.toMatch(/[{}\\]/);
    }
  });
  it("radius is clamped to 60 km whatever the trip says (DB allows 200)", () => {
    for (const k of Object.keys(INTEREST_SOURCES) as (keyof typeof INTEREST_SOURCES)[]) {
      expect(radiusForInterest(k, 200)).toBeLessThanOrEqual(MAX_RADIUS_KM);
    }
  });
  it("unknown / hostile interest strings never become keys", () => {
    const hostile = ['golf"];out;//', "__proto__", "constructor", "toString", "../x", "GOLF"];
    const r = interestsForTrip({ v: 1, interests: hostile } as never);
    expect(r.keys).toEqual(["general"]);
    expect(r.customInterests).toEqual(hostile);
  });
  it("lat/lon are formatted numerically (NaN would be a defect upstream, never user text)", () => {
    const q = buildQuery(['["leisure"="golf_course"]'], center, 1234.6);
    expect(q).toContain("(around:1235,36.51543,-4.88583)");
  });
});

describe("api_cache keys and user agent", () => {
  it("cache key normalisation cannot be used to collide different endpoints/versions", () => {
    expect(cacheKey("search", 1, { q: "a" })).not.toBe(cacheKey("search", 2, { q: "a" }));
    expect(cacheKey("search", 1, { q: "a" })).not.toBe(cacheKey("get", 1, { q: "a" }));
  });
  it("a hostile search text stays inside one key and below the 500-char DB limit for max-length input", () => {
    const key = cacheKey("search", 1, { q: "x;lang=de".repeat(8), lang: "en" });
    expect(key.length).toBeLessThanOrEqual(500);
  });
  it("user agent never contains secrets, only APP_URL and contact", () => {
    const ua = userAgent({ APP_URL: "https://x.app", INTEGRATIONS_CONTACT: "me@x.app", SUPABASE_SECRET_KEY: "SECRET" });
    expect(ua).toBe("TravelPlanner/1.0 (+https://x.app; me@x.app)");
    expect(ua).not.toContain("SECRET");
  });
});
