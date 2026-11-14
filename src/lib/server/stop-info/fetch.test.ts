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

import { fetchStopInfoBatch, osmTagsQuery } from "./fetch";

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

  it("Overpass down → every stop unfinished, nothing stored as 'none'", async () => {
    h.runQuery.mockRejectedValue(new Error("down"));
    const r = await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "de", ctx);
    expect(r).toEqual({ entries: [], unfinished: ["osm:w1", "osm:n2"], calls: 0 });
  });

  it("Wikidata down → its stops unfinished; a title-only stop still gets its text", async () => {
    h.entities.mockRejectedValue(new Error("down"));
    const r = await fetchStopInfoBatch([{ key: "osm:w1" }, { key: "osm:n2" }], "en", ctx);
    expect(r.unfinished).toEqual(["osm:w1"]);
    expect(r.entries.map((e) => e.key)).toEqual(["osm:n2"]);
    expect(r.entries[0].qid).toBeUndefined();
  });

  it("no eligible stop → no call at all", async () => {
    expect(await fetchStopInfoBatch([{ key: "geo:1" }], "de", ctx)).toEqual({ entries: [], unfinished: [], calls: 0 });
    expect(h.calls).toHaveLength(0);
  });
});
