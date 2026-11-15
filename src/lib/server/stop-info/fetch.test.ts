import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  calls: [] as { endpoint: string; provider: string; key: string }[],
  runQuery: vi.fn(),
  entities: vi.fn(),
  labels: vi.fn(),
  extracts: vi.fn(),
  thumbs: vi.fn(),
}));
vi.mock("../api-cache", async (orig) => ({
  ...(await orig<typeof import("../api-cache")>()),
  cached: async (o: { key: string; endpoint: string; provider: string; schema: { parse: (v: unknown) => unknown }; fetcher: () => Promise<{ data: unknown }> }) => {
    h.calls.push({ endpoint: o.endpoint, provider: o.provider, key: o.key });
    if (h.store.has(o.key)) return { ok: true, data: h.store.get(o.key), fetchedAt: "2026-11-01T00:00:00.000Z", stale: false, cache: "hit" };
    try {
      const data = o.schema.parse((await o.fetcher()).data);
      h.store.set(o.key, data);
      return { ok: true, data, fetchedAt: "2026-11-14T00:00:00.000Z", stale: false, cache: "miss" };
    } catch {
      return { ok: false, error: "provider_error" };
    }
  },
}));
vi.mock("@/lib/integrations/overpass", () => ({ runQuery: h.runQuery }));
vi.mock("@/lib/integrations/wikimedia-stops", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/wikimedia-stops")>()),
  fetchStopEntities: h.entities,
  fetchLabels: h.labels,
  fetchExtracts: h.extracts,
  fetchCommonsThumbs: h.thumbs,
}));

import { OVERPASS_REQUEST_CAP_MS, fetchStopInfoBatch, osmTagsQuery } from "./fetch";

const ctx = { userId: "u1" };
const ok = <T,>(data: T) => ({ ...data, status: 200, latencyMs: 5 });

beforeEach(() => {
  h.store.clear();
  h.calls.length = 0;
  h.runQuery.mockReset().mockResolvedValue({
    elements: [
      { type: "way", id: 1, lat: 0, lon: 0, tags: { wikidata: "Q1", website: "dom.example", name: "x" } },
      { type: "node", id: 2, lat: 0, lon: 0, tags: { wikipedia: "en:Prater" } },
    ],
    status: 200,
    latencyMs: 5,
  });
  h.entities.mockReset().mockResolvedValue(ok({ entities: new Map([["Q1", { sitelinks: { en: "St. Stephen's Cathedral" }, image: null, year: 1147, architects: [], heritage: null, website: null }]]) }));
  h.labels.mockReset().mockResolvedValue(ok({ labels: new Map() }));
  h.extracts.mockReset().mockImplementation(async (lang: string, titles: string[]) =>
    ok({ extracts: new Map(titles.map((t) => [t, { title: t, text: `${lang} text of ${t}.` }])) }),
  );
  h.thumbs.mockReset().mockResolvedValue(ok({ thumbs: new Map() }));
});

describe("fetchStopInfoBatch", () => {
  it("one Overpass union query for all osm stops (tags and centre)", () => {
    expect(osmTagsQuery([{ type: "way", id: 1 }, { type: "node", id: 2 }, { type: "relation", id: 3 }])).toBe(
      "[out:json][timeout:10];(node(id:2);way(id:1);relation(id:3););out tags center;",
    );
  });

  it("de owner: no German article → English fallback, labelled en; geo/gfy keys skipped", async () => {
    const r = await fetchStopInfoBatch([{ key: "osm:w1", cat: "place_of_worship" }, { key: "osm:n2" }, { key: "geo:9" }, { key: "gfy:x" }], "de", ctx);
    expect(r.unfinished).toEqual([]);
    expect(r.entries.map((e) => [e.key, e.lang, e.title])).toEqual([
      ["osm:w1", "en", "St. Stephen's Cathedral"],
      ["osm:n2", "en", "Prater"],
    ]);
    expect(r.entries[0].facts).toMatchObject({ year: 1147, yearKind: "built", website: "https://dom.example/", websiteFrom: "osm" });
    // No German title at all: the de pass sends nothing, one en request.
    expect(h.calls.map((c) => c.endpoint)).toEqual(["stop_osm_tags", "stop_entities", "stop_extracts"]);
    expect(h.extracts.mock.calls.map((c) => c[0])).toEqual(["en"]);
    expect(r.calls).toBe(3);
    expect(r.entries[0].checkedAt).toBe("2026-11-14T00:00:00.000Z");
  });

  it("a second batch with the same stops is served from the cache (0 network calls)", async () => {
    await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "de", ctx);
    const r = await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "de", ctx);
    expect(r.calls).toBe(0);
    expect(h.runQuery).toHaveBeenCalledTimes(1);
  });

  it("Overpass down → every stop unfinished, nothing stored as 'none'; the failed request still counts", async () => {
    h.runQuery.mockRejectedValue(new Error("down"));
    const r = await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "de", ctx);
    expect(r).toMatchObject({ entries: [], unfinished: ["osm:w1", "osm:n2"], calls: 1 });
  });

  it("offline (limit used up): cached answers only, no request", async () => {
    await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "de", ctx);
    h.runQuery.mockClear();
    const r = await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "de", ctx, { deadline: Date.now() + 4000, now: Date.now, offline: true });
    expect(r.calls).toBe(0);
    expect(r.entries).toHaveLength(2);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  it("a failed labels request leaves stops that need those labels unfinished", async () => {
    h.entities.mockResolvedValue(ok({ entities: new Map([["Q1", { sitelinks: { en: "X" }, image: null, year: null, architects: ["Q7"], heritage: null, website: null }]]) }));
    h.labels.mockRejectedValue(new Error("down"));
    const r = await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "en", ctx);
    expect(r.unfinished).toEqual(["osm:w1"]);
  });

  it("storedAt is the batch time even when the answers came from an older cache", async () => {
    await fetchStopInfoBatch([{ key: "osm:w1" }], "en", ctx);
    const r = await fetchStopInfoBatch([{ key: "osm:w1" }], "en", ctx, { deadline: Date.parse("2026-12-01T00:00:04Z"), now: () => Date.parse("2026-12-01T00:00:00Z") });
    expect(r.entries[0].checkedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(r.entries[0].storedAt).toBe("2026-12-01T00:00:00.000Z");
  });

  it("Wikidata down → its stops unfinished; a title-only stop still gets its text", async () => {
    h.entities.mockRejectedValue(new Error("down"));
    const r = await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "en", ctx);
    expect(r.unfinished).toEqual(["osm:w1"]);
    expect(r.entries.map((e) => e.key)).toEqual(["osm:n2"]);
    expect(r.entries[0].qid).toBeUndefined();
  });

  it("no eligible stop → no call at all", async () => {
    expect(await fetchStopInfoBatch([{ key: "geo:1" }], "de", ctx)).toMatchObject({ entries: [], unfinished: [], calls: 0 });
    expect(h.calls).toHaveLength(0);
  });

  describe("landmark fast path (decisions 2026-11-15)", () => {
    const qids = new Map([["osm:w1", "Q1"]]);

    it("request path: a stop with a known Wikidata id skips Overpass and becomes a partial card", async () => {
      const r = await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "en", ctx, undefined, { qids, tags: "unknown" });
      // Overpass is asked only for the stop without a known id.
      expect(h.runQuery).toHaveBeenCalledTimes(1);
      expect(h.runQuery.mock.calls[0][0]).toBe(osmTagsQuery([{ type: "node", id: 2 }]));
      const w1 = r.entries.find((e) => e.key === "osm:w1")!;
      expect(w1).toMatchObject({ status: "ok", qid: "Q1", title: "St. Stephen's Cathedral", partial: true });
      expect(w1.facts?.website).toBeUndefined(); // OSM website comes with the background fetch
      expect(r.entries.find((e) => e.key === "osm:n2")?.partial).toBeUndefined();
    });

    it("a failed Overpass call never blocks stops with a known id; others stay unfinished", async () => {
      h.runQuery.mockRejectedValue(Object.assign(new Error("502"), { status: 502 }));
      const r = await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "en", ctx, undefined, { qids, tags: "unknown" });
      expect(r.entries.map((e) => [e.key, e.partial])).toEqual([["osm:w1", true]]);
      expect(r.unfinished).toEqual(["osm:n2"]);
      // Same in the background mode: Overpass down still yields the partial card.
      h.store.clear();
      const bg = await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "en", ctx, undefined, { qids, tags: "all" });
      expect(bg.entries.map((e) => [e.key, e.partial])).toEqual([["osm:w1", true]]);
      expect(bg.unfinished).toEqual(["osm:n2"]);
    });

    it("request path: Overpass failing slowly at its deadline leaves time for the known stop's partial card", async () => {
      let overpassDeadline = 0;
      h.runQuery.mockImplementation(async (_q: string, o: { deadline: number }) => {
        overpassDeadline = o.deadline;
        await new Promise((r) => setTimeout(r, Math.max(0, o.deadline - Date.now())));
        throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      });
      const started = Date.now();
      const r = await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "en", ctx, undefined, { qids, tags: "unknown" });
      expect(overpassDeadline - started).toBeLessThanOrEqual(OVERPASS_REQUEST_CAP_MS + 50); // capped, not the full 4 s
      expect(r.entries.map((e) => [e.key, e.partial])).toEqual([["osm:w1", true]]);
      expect(r.unfinished).toEqual(["osm:n2"]);
    }, 10_000);

    it("background mode asks Overpass for every stop: full cards with OSM facts, not partial", async () => {
      const r = await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "en", ctx, undefined, { qids, tags: "all" });
      expect(h.runQuery.mock.calls[0][0]).toBe(osmTagsQuery([{ type: "way", id: 1 }, { type: "node", id: 2 }]));
      const w1 = r.entries.find((e) => e.key === "osm:w1")!;
      expect(w1.partial).toBeUndefined();
      expect(w1.facts).toMatchObject({ website: "https://dom.example/", websiteFrom: "osm" });
    });

    it("a repeated batch for the same stops is served from the cache (no new requests)", async () => {
      await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "en", ctx, undefined, { qids, tags: "all" });
      const again = await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "en", ctx, undefined, { qids, tags: "all" });
      expect(h.runQuery).toHaveBeenCalledTimes(1);
      expect(h.entities).toHaveBeenCalledTimes(1);
      expect(again.calls).toBe(0);
      expect(again.entries).toHaveLength(2);
    });
  });
});
