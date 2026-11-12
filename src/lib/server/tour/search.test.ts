import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
type Opts = { provider: string; endpoint: string; key: string; fetchAllowed?: () => boolean; fetcher: () => Promise<{ data: unknown }> };
const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  calls: [] as { provider: string; endpoint: string; key: string; allowed: boolean }[],
  fetchJson: vi.fn(),
  runQuery: vi.fn(),
  enqueue: vi.fn(),
  after: vi.fn(),
}));
vi.mock("../api-cache", async (orig) => ({
  ...(await orig<typeof import("../api-cache")>()),
  cached: async (o: Opts) => {
    const allowed = o.fetchAllowed ? o.fetchAllowed() : true;
    h.calls.push({ provider: o.provider, endpoint: o.endpoint, key: o.key, allowed });
    if (h.store.has(o.key)) return { ok: true, data: h.store.get(o.key), fetchedAt: "2026-11-12T00:00:00.000Z", stale: false, cache: "hit" };
    if (!allowed) return { ok: false, error: "timeout" };
    try {
      const out = await o.fetcher();
      h.store.set(o.key, out.data);
      return { ok: true, data: out.data, fetchedAt: "2026-11-12T01:00:00.000Z", stale: false, cache: "miss" };
    } catch {
      return { ok: false, error: "provider_error" };
    }
  },
}));
vi.mock("../facts/geoapify-quota", () => ({ assertGeoapifyQuota: async () => {} }));
vi.mock("../place-retries", () => ({ enqueuePlaceRetries: h.enqueue }));
vi.mock("next/server", () => ({ after: h.after }));
vi.mock("@/lib/integrations/http", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/http")>()), fetchJson: h.fetchJson }));
vi.mock("@/lib/integrations/overpass", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/overpass")>()), runQuery: h.runQuery }));

import { collectLandmarks } from "@/lib/facts/landmarks";
import { parseElements } from "@/lib/integrations/overpass";
import { landmarksKey, resetLandmarkWarmState, sitelinksKey } from "./landmarks";
import { mergeSearch, searchTourPlaces } from "./search";

/** Recorded 2026-11-12 (issue #172): Frankfurt landmarks (Overpass + Wikidata) and Geoapify type=amenity answers. */
const fx = (p: string) => JSON.parse(readFileSync(join(__dirname, "../../integrations/__fixtures__", p), "utf8"));
const FFM = { lat: 50.11552, lon: 8.68417 };
const landmarks = collectLandmarks(parseElements(fx("overpass/landmarks-frankfurt-8km.json")), { lat: 50.116, lon: 8.684 });
const ANSWERS: Record<string, string> = {
  dom: "amenity-dom-frankfurt-de",
  kaiserdom: "amenity-kaiserdom-frankfurt-de",
  "alte oper": "amenity-alte-oper-frankfurt-de",
  hauptbahnhof: "amenity-hauptbahnhof-frankfurt-de",
  römer: "amenity-roemer-frankfurt-de",
};
const search = (q: string, use: "place" | "endpoint" = "place") => searchTourPlaces({ q, ...FFM, lang: "de", use }, { userId: "u1" });

beforeEach(() => {
  h.store.clear();
  h.calls.length = 0;
  h.fetchJson.mockReset().mockImplementation(async (url: string) => {
    const text = new URL(url).searchParams.get("text")!;
    return { status: 200, latencyMs: 300, body: fx(`geoapify-autocomplete/${ANSWERS[text]}.json`) };
  });
  h.runQuery.mockReset();
  h.enqueue.mockReset();
  h.after.mockReset();
  resetLandmarkWarmState();
  vi.stubEnv("GEOAPIFY_API_KEY", "gk");
});

function cacheLandmarks() {
  h.store.set(landmarksKey(FFM), landmarks);
  h.store.set(sitelinksKey(FFM, landmarks.map((l) => l.wikidata)), fx("wikidata/sitelinks-frankfurt.json"));
}

describe("tour place search (Frankfurt)", () => {
  it.each([
    ["Dom", "Kaiserdom St. Bartholomäus"],
    ["Kaiserdom", "Kaiserdom St. Bartholomäus"],
    ["Alte Oper", "Alte Oper"],
    ["Hauptbahnhof", "Frankfurt (Main) Hauptbahnhof"],
    ["Römer", "Römer"],
  ])("%s → the landmark first, then no addresses, shops, stops, car parks, hotels or offices", async (q, want) => {
    cacheLandmarks();
    const r = await search(q);
    if (!r.ok) throw new Error("not ok");
    expect(r.local[0]).toMatchObject({ name: want, key: expect.stringMatching(/^osm:[nwr]\d+$/) });
    const all = [...r.local.map((p) => p.name), ...r.remote.map((s) => s.name)];
    expect(all.length).toBeLessThanOrEqual(8);
    for (const bad of [/apotheke/i, /domino/i, /dominion/i, /tiefgarage/i, /vorplatz/i, /holiday inn/i, /motel/i, /abonnement/i, /tourist information/i, /münchener straße/i]) {
      expect(all.some((n) => bad.test(n))).toBe(false);
    }
    // A station's levels and stops collapse into the station; the U-Bahn "Dom/Römer" into the Dom and the Römer.
    expect(r.remote.map((s) => s.name)).not.toContain("Dom/Römer");
    expect(r.remote.map((s) => s.name)).not.toContain("Hauptbahnhof");
    expect(r.remote.every((s) => !s.address || /\d{5}/.test(s.address))).toBe(true);
  });

  it("first three results (recorded for the spec)", async () => {
    cacheLandmarks();
    const top3: Record<string, string[]> = {};
    for (const q of ["Dom", "Kaiserdom", "Alte Oper", "Hauptbahnhof", "Römer"]) {
      const r = await search(q);
      if (r.ok) top3[q] = [...r.local.map((p) => p.name), ...r.remote.map((s) => s.name)].slice(0, 3);
    }
    expect(top3).toEqual({
      Dom: ["Kaiserdom St. Bartholomäus", "Dominikanerkloster", "Dommuseum"],
      Kaiserdom: ["Kaiserdom St. Bartholomäus"],
      "Alte Oper": ["Alte Oper"],
      // The S-Bahn level "Hauptbahnhof (tief)" (own Wikidata item, 60 m away) is part of the station.
      Hauptbahnhof: ["Frankfurt (Main) Hauptbahnhof", "Offenbach (Main) Hauptbahnhof"],
      Römer: ["Römer", "Römerberg", "Haus zum Römer"],
    });
  });

  it("asks Geoapify for POIs (type=amenity, v2 key) and never queries Overpass or Wikidata inline", async () => {
    cacheLandmarks();
    await search("Alte Oper");
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.fetchJson).toHaveBeenCalledTimes(1);
    expect(new URL(h.fetchJson.mock.calls[0][0]).searchParams.get("type")).toBe("amenity");
    for (const c of h.calls.filter((x) => x.provider !== "geoapify")) expect(c.allowed).toBe(false);
    expect(h.calls.map((c) => c.key)).toContain("autocomplete:v2:cell=50.12,8.68;lang=de;q=alte oper;type=amenity");
  });

  it("landmark set not cached yet: Geoapify POIs only (the Kaiserdom without category stays), warm-up after the response", async () => {
    const r = await search("Kaiserdom");
    expect(r.ok && r.remote.map((s) => s.name)).toEqual(["Kaiserdom St. Bartholomäus"]);
    expect(r.ok && r.local).toEqual([]);
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0][0][0]).toMatchObject({ kind: "interest", params: { interest: "landmarks", lat: 50.116, lon: 8.684, radiusKm: 8 } });
    // The next keystroke on this instance does not schedule it again.
    await search("Kaiserdom");
    expect(h.after).toHaveBeenCalledTimes(1);
  });

  it("start and end (`endpoint`): landmarks first, addresses and hotels allowed (v1 key, no type)", async () => {
    cacheLandmarks();
    const r = await search("Alte Oper", "endpoint");
    if (!r.ok) throw new Error("not ok");
    expect(r.local[0].name).toBe("Alte Oper");
    expect(r.remote.map((s) => s.name)).toContain("Holiday Inn Frankfurt - Alte Oper");
    expect(new URL(h.fetchJson.mock.calls[0][0]).searchParams.has("type")).toBe(false);
  });

  it("Geoapify down: the landmark matches still answer; with none, `unavailable`", async () => {
    cacheLandmarks();
    h.fetchJson.mockRejectedValue(Object.assign(new Error("x"), { status: 503 }));
    const r = await search("Römer");
    expect(r.ok && r.local[0].name).toBe("Römer");
    expect(await search("Xyzabc")).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("mergeSearch", () => {
  const kaiserdom = landmarks.find((l) => l.wikidata === "Q57341")!;
  const s = (name: string, lat: number, lon: number, category?: string) => ({
    key: `gfy:${"0".repeat(32)}`,
    placeId: "ab",
    name,
    lat,
    lon,
    datasource: "openstreetmap",
    ...(category ? { category } : {}),
  });

  it("caps at 8, landmarks first; uncategorized results only without a landmark match (places)", () => {
    const remote = [s("Domplatz Café", 50.2, 8.7), s("Dominikanerkloster", 50.11, 8.69, "tourism.sights")];
    expect(mergeSearch([kaiserdom], remote, "place").remote.map((r) => r.name)).toEqual(["Dominikanerkloster"]);
    expect(mergeSearch([], remote, "place").remote).toHaveLength(2);
    expect(mergeSearch([kaiserdom], remote, "endpoint").remote).toHaveLength(2);
    expect(mergeSearch(Array(10).fill(kaiserdom), remote, "place").local).toHaveLength(8);
  });
});
