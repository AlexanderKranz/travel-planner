import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
type Opts = { provider: string; endpoint: string; key: string; ttlSeconds: number; fetchAllowed?: () => boolean; fetcher: () => Promise<{ data: unknown; units?: number; variant?: string }> };
const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  stale: new Set<string>(),
  calls: [] as { provider: string; endpoint: string; key: string; ttl: number; allowed: boolean }[],
  outcomes: [] as { units?: number; variant?: string }[],
  runQuery: vi.fn(),
  fetchJson: vi.fn(),
  enqueue: vi.fn(),
  after: vi.fn(),
}));
vi.mock("../api-cache", async (orig) => ({
  ...(await orig<typeof import("../api-cache")>()),
  cached: async (o: Opts) => {
    const allowed = o.fetchAllowed ? o.fetchAllowed() : true;
    h.calls.push({ provider: o.provider, endpoint: o.endpoint, key: o.key, ttl: o.ttlSeconds, allowed });
    if (h.store.has(o.key) && !(h.stale.has(o.key) && allowed)) {
      return { ok: true, data: h.store.get(o.key), fetchedAt: "2026-11-01T00:00:00.000Z", stale: h.stale.has(o.key), cache: "hit" };
    }
    if (!allowed) return { ok: false, error: "timeout" };
    try {
      const out = await o.fetcher();
      h.outcomes.push(out);
      h.store.set(o.key, out.data);
      h.stale.delete(o.key);
      return { ok: true, data: out.data, fetchedAt: "2026-11-12T00:00:00.000Z", stale: false, cache: "miss" };
    } catch {
      return { ok: false, error: "provider_error" };
    }
  },
}));
vi.mock("../place-retries", () => ({ enqueuePlaceRetries: h.enqueue }));
vi.mock("next/server", () => ({ after: h.after }));
vi.mock("@/lib/integrations/http", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/http")>()), fetchJson: h.fetchJson }));
vi.mock("@/lib/integrations/overpass", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/overpass")>()), runQuery: h.runQuery }));

import { LANDMARK_FILTERS } from "@/lib/facts/landmarks";
import { parseElements } from "@/lib/integrations/overpass";
import {
  landmarksKey,
  readLandmarks,
  resetLandmarkWarmState,
  scheduleLandmarkWarm,
  sitelinksKey,
  warmLandmarks,
  WARM_COOLDOWN_MS,
} from "./landmarks";

const fx = (p: string) => JSON.parse(readFileSync(join(__dirname, "../../integrations/__fixtures__", p), "utf8"));
const FFM = { lat: 50.11552, lon: 8.68417 };
const overpass = fx("overpass/landmarks-frankfurt-8km.json");
const sitelinks = fx("wikidata/sitelinks-frankfurt.json") as Record<string, number>;

beforeEach(() => {
  h.store.clear();
  h.stale.clear();
  h.calls.length = 0;
  h.outcomes.length = 0;
  h.runQuery.mockReset().mockResolvedValue({ elements: parseElements(overpass), status: 200, latencyMs: 50_000, mirror: "overpass-api.de" });
  h.fetchJson.mockReset().mockImplementation(async (url: string) => {
    const titles = new URL(url).searchParams.get("titles")!.split("|");
    return {
      status: 200,
      latencyMs: 250,
      body: { query: { pages: titles.map((q) => ({ title: q, pageprops: { "wb-sitelinks": String(sitelinks[q] ?? 0) } })) } },
    };
  });
  h.enqueue.mockReset();
  h.after.mockReset();
  resetLandmarkWarmState();
});

describe("landmark cache keys", () => {
  it("anchor rounded to 3 decimals, radius 8 km; nearby points share the key", () => {
    expect(landmarksKey(FFM)).toBe("landmarks:v1:lat=50.116;lon=8.684;r=8");
    expect(landmarksKey({ lat: 50.1157, lon: 8.6838 })).toBe(landmarksKey(FFM));
  });

  it("sitelinks: also a hash of the set's ids, so a refreshed set with other ids gets its counts fetched", () => {
    const k = sitelinksKey(FFM, ["Q57341", "Q165368"]);
    expect(k).toMatch(/^sitelinks:v1:ids=[0-9a-f]{16};lat=50\.116;lon=8\.684;r=8$/);
    expect(sitelinksKey({ lat: 50.1157, lon: 8.6838 }, ["Q165368", "Q57341", "Q57341"])).toBe(k);
    expect(sitelinksKey(FFM, ["Q57341", "Q165368", "Q1"])).not.toBe(k);
  });
});

describe("readLandmarks (user requests)", () => {
  it("cache only: never Overpass or Wikidata, null when not cached", async () => {
    expect(await readLandmarks(FFM, { userId: "u1" })).toBeNull();
    expect(h.calls.every((c) => !c.allowed)).toBe(true);
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.fetchJson).not.toHaveBeenCalled();
  });

  it("ranks by sitelinks when cached; without them the fallback order and `prominence: false`", async () => {
    await warmLandmarks(FFM, { userId: null }, 100_000);
    resetLandmarkWarmState();
    h.calls.length = 0;
    const r = await readLandmarks(FFM, { userId: "u1" });
    expect(r).toMatchObject({ prominence: true, needsWarm: false });
    expect(r!.ranked.slice(0, 3).map((l) => l.name)).toEqual(["Frankfurter Wertpapierbörse", "Paulskirche", "Kaiserdom St. Bartholomäus"]);
    expect(h.calls.map((c) => [c.provider, c.endpoint, c.allowed])).toEqual([
      ["overpass", "landmarks", false],
      ["wikidata", "sitelinks", false],
    ]);
    // A complete set is read from memory for 5 minutes (Wien's set is ~340 KB, the search reads it per keystroke).
    const t = Date.now();
    await readLandmarks(FFM, { userId: "u1" }, t);
    await readLandmarks(FFM, { userId: "u1" }, t + 60_000);
    expect(h.calls).toHaveLength(2);
    for (const k of [...h.store.keys()]) if (k.startsWith("sitelinks:")) h.store.delete(k);
    resetLandmarkWarmState();
    expect(await readLandmarks(FFM, { userId: "u1" })).toMatchObject({ prominence: false, needsWarm: true });
  });

  it("an expired set is still served, but a warm-up is due", async () => {
    await warmLandmarks(FFM, { userId: null }, 100_000);
    resetLandmarkWarmState();
    h.stale.add(landmarksKey(FFM));
    expect(await readLandmarks(FFM, { userId: "u1" })).toMatchObject({ prominence: true, needsWarm: true });
  });
});

describe("warmLandmarks (after the response, retry worker)", () => {
  it("one Overpass query with the landmark filters, then sitelinks in batches of 50; TTLs 30 / 90 days", async () => {
    expect(await warmLandmarks(FFM, { userId: null }, 100_000)).toBe("ok");
    expect(h.runQuery).toHaveBeenCalledTimes(1);
    const query = h.runQuery.mock.calls[0][0] as string;
    for (const f of LANDMARK_FILTERS) expect(query).toContain(f);
    expect(query).toContain("out center tags 3000;");
    expect(h.calls.map((c) => [c.provider, c.endpoint, c.ttl, c.allowed])).toEqual([
      ["overpass", "landmarks", 30 * 86400, true],
      ["wikidata", "sitelinks", 90 * 86400, true],
      // Read back from the cache before reporting done.
      ["overpass", "landmarks", 30 * 86400, false],
      ["wikidata", "sitelinks", 90 * 86400, false],
    ]);
    const ids = new Set((h.store.get(landmarksKey(FFM)) as { wikidata: string }[]).map((l) => l.wikidata));
    expect(h.fetchJson).toHaveBeenCalledTimes(Math.ceil(ids.size / 50));
    expect(h.outcomes[1]).toMatchObject({ units: Math.ceil(ids.size / 50) });
    expect(h.outcomes[0]).toMatchObject({ variant: "overpass-api.de" });
  });

  it("concurrent warm-ups for one point share one Overpass query; a cached set is not fetched again", async () => {
    await Promise.all([warmLandmarks(FFM, { userId: null }, 100_000), warmLandmarks({ lat: 50.1159, lon: 8.6839 }, { userId: null }, 100_000)]);
    await warmLandmarks(FFM, { userId: null }, 100_000);
    expect(h.runQuery).toHaveBeenCalledTimes(1);
  });

  it("Overpass or Wikidata failing: `failed`, nothing cached for the failed part", async () => {
    h.runQuery.mockRejectedValueOnce(Object.assign(new Error("x"), { status: 504 }));
    expect(await warmLandmarks(FFM, { userId: null }, 100_000)).toBe("failed");
    expect(h.store.size).toBe(0);
    h.fetchJson.mockRejectedValue(Object.assign(new Error("x"), { status: 503 }));
    expect(await warmLandmarks(FFM, { userId: null }, 100_000)).toBe("failed");
    expect(h.store.has(landmarksKey(FFM))).toBe(true);
    expect([...h.store.keys()].some((k) => k.startsWith("sitelinks:"))).toBe(false);
  });

  it("a stale answer (refresh failed, expired entry served) or a cache write that did not land is not done", async () => {
    await warmLandmarks(FFM, { userId: null }, 100_000);
    h.stale.add(landmarksKey(FFM));
    h.runQuery.mockRejectedValueOnce(Object.assign(new Error("x"), { status: 504 }));
    expect(await warmLandmarks(FFM, { userId: null }, 100_000)).toBe("failed");
    h.store.clear();
    h.stale.clear();
    const realSet = h.store.set.bind(h.store);
    h.store.set = ((k: string, v: unknown) => (k.startsWith("sitelinks:") ? h.store : realSet(k, v))) as typeof h.store.set;
    expect(await warmLandmarks(FFM, { userId: null }, 100_000)).toBe("failed");
    h.store.set = realSet;
  });
});

describe("scheduleLandmarkWarm", () => {
  it("queues the retry job and warms after the response, once per point and instance in the cooldown", async () => {
    const now = Date.now();
    await scheduleLandmarkWarm(FFM, now);
    await scheduleLandmarkWarm({ lat: 50.1158, lon: 8.6842 }, now + 1000);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0][0]).toEqual([
      { kind: "interest", cache_key: "interest:landmarks:50.116:8.684:8", params: { kind: "interest", interest: "landmarks", lat: 50.116, lon: 8.684, radiusKm: 8 } },
    ]);
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.runQuery).not.toHaveBeenCalled(); // nothing inline
    await h.after.mock.calls[0][0]();
    expect(h.runQuery).toHaveBeenCalledTimes(1);
    await scheduleLandmarkWarm(FFM, now + WARM_COOLDOWN_MS + 1);
    expect(h.enqueue).toHaveBeenCalledTimes(2);
  });

  it("after() unavailable (outside a request): the queued job is enough", async () => {
    h.after.mockImplementation(() => {
      throw new Error("outside request scope");
    });
    await expect(scheduleLandmarkWarm(FFM)).resolves.toBeUndefined();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
});
