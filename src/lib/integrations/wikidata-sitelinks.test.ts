import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock("./http", async (orig) => ({ ...(await orig<typeof import("./http")>()), fetchJson: h.fetchJson }));

import { fetchSitelinkCounts, parseSitelinks, sitelinksUrl } from "./wikidata-sitelinks";

/** Recorded live 2026-11-12: pageprops wb-sitelinks of the 50 best-known Frankfurt landmark items. */
const recorded = JSON.parse(readFileSync(join(__dirname, "__fixtures__/wikidata/pageprops-sitelinks-frankfurt.json"), "utf8"));

const page = (q: string, n?: number) => ({ title: q, ns: 0, ...(n === undefined ? {} : { pageprops: { "wb-sitelinks": String(n) } }) });
const answer = (pages: unknown[]) => ({ status: 200, latencyMs: 5, body: { batchcomplete: true, query: { pages } } });

beforeEach(() => {
  h.fetchJson.mockReset();
});

describe("Wikidata sitelink counts", () => {
  it("URL: pageprops wb-sitelinks, formatversion 2, ids joined, maxlag", () => {
    const u = new URL(sitelinksUrl(["Q57341", "Q165368"]));
    expect(`${u.origin}${u.pathname}`).toBe("https://www.wikidata.org/w/api.php");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      action: "query",
      format: "json",
      formatversion: "2",
      prop: "pageprops",
      ppprop: "wb-sitelinks",
      titles: "Q57341|Q165368",
      maxlag: "5",
    });
  });

  it("parses the recorded answer (Kaiserdom 30, Frankfurt Hbf 33, Römer 20)", () => {
    const counts = parseSitelinks(recorded);
    expect(Object.keys(counts)).toHaveLength(50);
    expect(counts).toMatchObject({ Q57341: 30, Q165368: 33, Q195146: 20 });
  });

  it("an item without the page prop counts 0; a missing item is left out; an API error throws", () => {
    expect(parseSitelinks({ query: { pages: [page("Q1"), { title: "Q2", missing: true }] } })).toEqual({ Q1: 0 });
    expect(() => parseSitelinks({ error: { code: "maxlag" } })).toThrow(/maxlag/);
    expect(() => parseSitelinks({ batchcomplete: true })).toThrow();
  });

  it("batches of 50, one after the other; counts requests as units", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `Q${i + 1}`);
    let running = 0;
    h.fetchJson.mockImplementation(async (url: string) => {
      running += 1;
      expect(running).toBe(1); // never parallel
      const titles = new URL(url).searchParams.get("titles")!.split("|");
      expect(titles.length).toBeLessThanOrEqual(50);
      await Promise.resolve();
      running -= 1;
      return answer(titles.map((q) => page(q, 2)));
    });
    const r = await fetchSitelinkCounts([...ids, "Q1"]);
    expect(r.requests).toBe(3);
    expect(Object.keys(r.counts)).toHaveLength(120);
  });

  it("past the deadline no request starts and the call throws (nothing partial is cached)", async () => {
    h.fetchJson.mockResolvedValue(answer([page("Q1", 1)]));
    await expect(fetchSitelinkCounts(["Q1"], { deadline: Date.now() - 1 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(h.fetchJson).not.toHaveBeenCalled();
  });

  it("rejects ids that are not items; a failed request carries the requests made as units", async () => {
    await expect(fetchSitelinkCounts(["Q1", "P31"])).rejects.toThrow(RangeError);
    h.fetchJson.mockResolvedValueOnce(answer([page("Q1", 1)])).mockRejectedValueOnce(Object.assign(new Error("x"), { status: 503 }));
    const ids = Array.from({ length: 60 }, (_, i) => `Q${i + 1}`);
    await expect(fetchSitelinkCounts(ids)).rejects.toMatchObject({ status: 503, units: 2 });
    // An API error in the first answer is one request, one unit.
    h.fetchJson.mockResolvedValueOnce({ status: 200, latencyMs: 5, body: { error: { code: "maxlag" } } });
    await expect(fetchSitelinkCounts(["Q1"])).rejects.toMatchObject({ units: 1 });
  });
});
