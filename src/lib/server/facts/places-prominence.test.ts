import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
type Opts = { provider: string; endpoint: string; key: string; fetchAllowed?: () => boolean; fetcher: () => Promise<{ data: unknown }> };
const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  calls: [] as { provider: string; endpoint: string; key: string }[],
  runQuery: vi.fn(),
  fetchPlaces: vi.fn(),
  fetchJson: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock("../api-cache", async (orig) => ({
  ...(await orig<typeof import("../api-cache")>()),
  cached: async (o: Opts) => {
    h.calls.push({ provider: o.provider, endpoint: o.endpoint, key: o.key });
    if (h.store.has(o.key)) return { ok: true, data: h.store.get(o.key), fetchedAt: "f0", stale: false, cache: "hit" };
    if (o.fetchAllowed && !o.fetchAllowed()) return { ok: false, error: "timeout" };
    try {
      const out = await o.fetcher();
      h.store.set(o.key, out.data);
      return { ok: true, data: out.data, fetchedAt: "f1", stale: false, cache: "miss" };
    } catch {
      return { ok: false, error: "provider_error" };
    }
  },
}));
vi.mock("./geoapify-quota", () => ({ assertGeoapifyQuota: async () => {} }));
vi.mock("../place-retries", () => ({ enqueuePlaceRetries: h.enqueue }));
vi.mock("@/lib/integrations/geoapify", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/geoapify")>()),
  fetchPlaces: h.fetchPlaces,
  hasGeoapifyKey: () => true,
}));
vi.mock("@/lib/integrations/overpass", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/overpass")>()), runQuery: h.runQuery }));
vi.mock("@/lib/integrations/http", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/http")>()), fetchJson: h.fetchJson }));

import barcelona from "@/lib/integrations/__fixtures__/overpass/general-barcelona-15km.json";
import golf from "@/lib/integrations/__fixtures__/overpass/golf-marbella-40km.json";
import bcnSitelinks from "@/lib/integrations/__fixtures__/wikidata/sitelinks-barcelona.json";
import { parseElements } from "@/lib/integrations/overpass";
import type { GeoDestination } from "./common";
import { getInterestGroups, retryInterestLookup } from "./places";

const sitelinks = bcnSitelinks as Record<string, number>;
const ctx = { userId: null, locale: "de" as const, today: "2026-11-12" };
const bcn = { kind: "city", name: "Barcelona", placeName: "Barcelona", geoId: 3128760, countryCode: "ES", admin1: null, lat: 41.38879, lon: 2.15899, timezone: "Europe/Madrid", radiusKm: 15 } as GeoDestination;
const names = (g: Awaited<ReturnType<typeof getInterestGroups>>[number]) => (g.status === "ok" ? g.candidates.map((c) => c.name) : []);

beforeEach(() => {
  h.store.clear();
  h.calls.length = 0;
  h.enqueue.mockReset();
  h.runQuery.mockReset().mockResolvedValue({ elements: parseElements(barcelona), status: 200, latencyMs: 40_000, mirror: "overpass-api.de" });
  h.fetchPlaces.mockReset().mockResolvedValue({ elements: parseElements(barcelona), status: 200, latencyMs: 900, credits: 15, truncated: false });
  h.fetchJson.mockReset().mockImplementation(async (url: string) => {
    const titles = new URL(url).searchParams.get("titles")!.split("|");
    return { status: 200, latencyMs: 250, body: { query: { pages: titles.map((q) => ({ title: q, pageprops: { "wb-sitelinks": String(sitelinks[q] ?? 0) } })) } } };
  });
});

describe("trip interest places ranked by prominence (issue #172)", () => {
  it("general via Geoapify: sitelinks fetched once (cached by ids), Sagrada Família at the top, v3 key", async () => {
    const [g] = await getInterestGroups(bcn, ["general"], ctx, 280_000);
    expect(names(g).slice(0, 2).sort()).toEqual(["Basílica de la Sagrada Família", "Spotify Camp Nou"]);
    expect(names(g)).toContain("Parc Güell");
    expect(h.calls.map((c) => `${c.provider}/${c.endpoint}`)).toEqual(["overpass/interpreter", "geoapify/places", "wikidata/sitelinks"]);
    expect(h.calls[0].key).toMatch(/^interpreter:v3:/);
    expect(h.calls[1].key).toMatch(/^places:v3:/);
    expect(h.calls[2].key).toMatch(/^sitelinks:v1:ids=[0-9a-f]{16};n=\d+$/);
    expect(h.fetchJson).toHaveBeenCalledTimes(2); // 66 ids → 2 requests of 50
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  it("general answered by Geoapify: the Overpass lookup is queued (Overpass first), never run inline", async () => {
    await getInterestGroups(bcn, ["general"], ctx, 280_000);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        cache_key: "interest:general:41.389:2.159:15:overpass",
        params: { kind: "interest", interest: "general", lat: 41.389, lon: 2.159, radiusKm: 15, overpass: true },
      }),
    ]);
    // Once Overpass is cached, it is used and nothing is queued.
    expect(await retryInterestLookup("general", bcn, 15, ctx, 100_000, { overpass: true })).toBe("ok");
    expect(h.runQuery).toHaveBeenCalledTimes(1);
    h.enqueue.mockReset();
    h.calls.length = 0;
    const [g] = await getInterestGroups(bcn, ["general"], ctx, 280_000);
    expect(h.calls.map((c) => c.provider)).toEqual(["overpass"]);
    expect(names(g)[0]).toMatch(/Sagrada|Camp Nou/);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("retry with `overpass`: skips Geoapify, ranks the Overpass answer by prominence", async () => {
    expect(await retryInterestLookup("general", bcn, 15, ctx, 100_000, { overpass: true })).toBe("ok");
    expect(h.fetchPlaces).not.toHaveBeenCalled();
    const stored = [...h.store.entries()].find(([k]) => k.startsWith("interpreter:v3:"))![1] as { name: string }[];
    expect(stored.slice(0, 2).map((c) => c.name).sort()).toEqual(["Basílica de la Sagrada Família", "Spotify Camp Nou"]);
  });

  it("Wikidata down: the list is still served, in the old order", async () => {
    h.fetchJson.mockRejectedValue(Object.assign(new Error("x"), { status: 503 }));
    const [g] = await getInterestGroups(bcn, ["general"], ctx, 280_000);
    expect(g.status).toBe("ok");
    expect(names(g)).not.toContain("Basílica de la Sagrada Família");
  });

  it("golf (no prominence): same v2 keys as before, no Wikidata call, nothing queued", async () => {
    h.fetchPlaces.mockResolvedValue({ elements: parseElements(golf), status: 200, latencyMs: 900, credits: 2, truncated: false });
    await getInterestGroups({ ...bcn, lat: 36.51, lon: -4.88 }, ["golf"], ctx, 280_000);
    expect(h.calls.map((c) => c.key.split(":").slice(0, 2).join(":"))).toEqual(["interpreter:v2", "places:v2"]);
    expect(h.fetchJson).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
