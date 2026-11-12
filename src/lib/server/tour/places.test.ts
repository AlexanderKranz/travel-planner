import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
type Opts = { provider: string; key: string; fetchAllowed?: () => boolean; fetcher: () => Promise<unknown> };
const h = vi.hoisted(() => ({
  calls: [] as Opts[],
  impl: ((): unknown => undefined) as (o: Opts) => unknown,
  enqueue: vi.fn(),
  runQuery: vi.fn(),
  after: vi.fn(),
}));
vi.mock("../api-cache", () => ({
  cached: (o: Opts) => {
    h.calls.push(o);
    return Promise.resolve(h.impl(o));
  },
  cacheKey: (e: string, v: number, p: Record<string, string | number>) => `${e}:v${v}:${JSON.stringify(p)}`,
}));
vi.mock("../facts/geoapify-quota", () => ({ assertGeoapifyQuota: async () => {} }));
vi.mock("../place-retries", () => ({ enqueuePlaceRetries: h.enqueue }));
vi.mock("next/server", () => ({ after: h.after }));
vi.mock("@/lib/integrations/overpass", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/overpass")>()), runQuery: h.runQuery }));

import { collectLandmarks } from "@/lib/facts/landmarks";
import { parseElements } from "@/lib/integrations/overpass";
import { resetLandmarkWarmState } from "./landmarks";
import { cityDestination, cityPlaces } from "./places";

const fx = (p: string) => JSON.parse(readFileSync(join(__dirname, "../../integrations/__fixtures__", p), "utf8"));
const dest = cityDestination({ name: "Wien", lat: 48.20849, lon: 16.37208 });
const ffm = cityDestination({ name: "Frankfurt am Main", lat: 50.11552, lon: 8.68417 });
const ffmLandmarks = collectLandmarks(parseElements(fx("overpass/landmarks-frankfurt-8km.json")), { lat: 50.116, lon: 8.684 });
const ffmSitelinks = fx("wikidata/sitelinks-frankfurt.json");
const candidate = {
  osmType: "way", osmId: 212496461, name: "Stephansdom", names: { en: "St. Stephen's Cathedral" }, category: "amenity=place_of_worship",
  lat: 48.2085, lon: 16.3731, distanceKm: 0.1, osmUrl: "https://www.openstreetmap.org/way/212496461",
};
const ok = (data: unknown, cache = "hit") => ({ ok: true, data, fetchedAt: "2026-11-01T00:00:00.000Z", stale: false, cache });
const miss = { ok: false, error: "timeout" };

beforeEach(() => {
  h.calls = [];
  h.enqueue.mockReset();
  h.runQuery.mockReset();
  h.after.mockReset();
  resetLandmarkWarmState();
  vi.stubEnv("GEOAPIFY_API_KEY", "k");
});
afterEach(() => vi.unstubAllEnvs());

describe("cityPlaces (tour suggestions and sights)", () => {
  it("landmarks cached: Frankfurt's main sights by prominence, OSM keys and links, 0 network calls", async () => {
    h.impl = (o) => (o.key.startsWith("landmarks:") ? ok(ffmLandmarks) : o.key.startsWith("sitelinks:") ? ok(ffmSitelinks) : miss);
    const r = await cityPlaces(ffm, ["general"], { userId: "u1", locale: "de", network: true });
    const top = r.places.slice(0, 15).map((p) => p.name);
    for (const n of ["Kaiserdom St. Bartholomäus", "Römer", "Alte Oper", "Paulskirche", "Frankfurt (Main) Hauptbahnhof", "Städel Museum", "Goethe-Haus", "Main Tower"]) {
      expect(top).toContain(n);
    }
    expect(top.indexOf("Kaiserdom St. Bartholomäus")).toBeLessThan(top.indexOf("Alte Oper"));
    expect(r.places.find((p) => p.name === "Kaiserdom St. Bartholomäus")).toEqual({
      key: "osm:w11018815",
      name: "Kaiserdom St. Bartholomäus",
      lat: expect.any(Number),
      lon: expect.any(Number),
      cat: "place_of_worship",
      url: "https://www.openstreetmap.org/way/11018815",
    });
    expect(r.places).toHaveLength(40);
    expect(r).toMatchObject({ pending: false, fetchedAt: "2026-11-01T00:00:00.000Z" });
    // `general` is replaced by the landmarks: no interest lookup, no fetch allowed anywhere.
    expect(h.calls.map((c) => c.key.split(":")[0])).toEqual(["landmarks", "sitelinks"]);
    expect(h.calls.every((c) => c.fetchAllowed?.() === false)).toBe(true);
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
  });

  it("names in the user's language; `limit` (sights take 60)", async () => {
    h.impl = (o) => (o.key.startsWith("landmarks:") ? ok(ffmLandmarks) : o.key.startsWith("sitelinks:") ? ok(ffmSitelinks) : miss);
    const r = await cityPlaces(ffm, ["general"], { userId: "u1", locale: "en", network: false, limit: 60 });
    expect(r.places).toHaveLength(60);
    expect(r.places.map((p) => p.name)).toContain("Imperial Cathedral of Saint Bartholomew");
  });

  it("a linked trip's purpose interests come after the landmarks", async () => {
    const museum = { ...candidate, osmId: 1, name: "Kleines Museum", names: {}, category: "tourism=museum", osmUrl: "https://www.openstreetmap.org/way/1" };
    h.impl = (o) =>
      o.key.startsWith("landmarks:") ? ok(ffmLandmarks) : o.key.startsWith("sitelinks:") ? ok(ffmSitelinks) : o.provider === "overpass" ? ok([museum]) : miss;
    const r = await cityPlaces(ffm, ["general", "museums"], { userId: "u1", locale: "de", network: true, limit: 200 });
    expect(r.places.at(-1)).toMatchObject({ key: "osm:w1", name: "Kleines Museum", cat: "museum" });
  });

  it("landmarks not cached yet: the `general` places stand in, pending, warm-up after the response (never inline)", async () => {
    h.impl = (o) => (o.provider === "overpass" && !o.key.startsWith("landmarks:") ? ok([candidate]) : miss);
    const r = await cityPlaces(dest, ["general"], { userId: "u1", locale: "en", network: true });
    expect(r).toEqual({
      places: [{ key: "osm:w212496461", name: "St. Stephen's Cathedral", lat: 48.2085, lon: 16.3731, cat: "place_of_worship", url: candidate.osmUrl }],
      pending: true,
      fetchedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0][0][0]).toMatchObject({ kind: "interest", params: { interest: "landmarks", lat: 48.208, lon: 16.372, radiusKm: 8 } });
  });

  it("never queries Overpass over the network, even when nothing is cached; the lookups are queued instead", async () => {
    h.impl = (o) => (o.provider === "overpass" ? { ok: false, error: "timeout" } : { ok: false, error: "provider_error" });
    const r = await cityPlaces(dest, ["general"], { userId: "u1", locale: "de", network: true });
    expect(r).toMatchObject({ places: [], pending: true });
    expect(h.calls.filter((c) => c.provider === "overpass").every((c) => c.fetchAllowed?.() === false)).toBe(true);
    expect(h.runQuery).not.toHaveBeenCalled();
    const queued = h.enqueue.mock.calls.flatMap((c) => c[0]).map((j: { params: { interest: string } }) => j.params.interest);
    expect(queued.sort()).toEqual(["general", "landmarks"]);
  });

  it("network: false allows no fetch at all and does not schedule a warm-up (the job is queued)", async () => {
    h.impl = () => ({ ok: false, error: "timeout" });
    await cityPlaces(dest, ["general"], { userId: "u1", locale: "de", network: false });
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.every((c) => c.fetchAllowed?.() === false)).toBe(true);
    expect(h.after).not.toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalled();
  });
});
