/**
 * Wikidata sitelink counts (keyless): how many Wikipedia/Wikimedia sites have an article on an item, the prominence
 * signal of city tour landmarks (src/lib/facts/landmarks.ts). Action API `action=query&prop=pageprops&ppprop=
 * wb-sitelinks` on wikidata.org: up to 50 item ids per request, a few KB per answer (3.9 KB for 50 in the spike).
 * Docs (checked 2026-11-12): https://www.mediawiki.org/wiki/API:Pageprops,
 * https://www.wikidata.org/w/api.php?action=help&modules=query%2Bpageprops, etiquette
 * https://www.mediawiki.org/wiki/API:Etiquette (serial requests, `maxlag` for non-interactive work, descriptive
 * User-Agent: `fetchJson` sends the app's, never a user's data), https://meta.wikimedia.org/wiki/User-Agent_policy.
 * Data: CC0 (https://www.wikidata.org/wiki/Wikidata:Licensing).
 *
 * Spike 2026-11-12: the counts equal `wikibase:sitelinks` from the Query Service for the 50 Frankfurt items checked
 * (Kaiserdom Q57341 = 30, Frankfurt Hbf Q165368 = 33); ~250 ms per request. `wbgetentities` has no count-only prop
 * (it returns every sitelink), so pageprops is the light way.
 */
import "server-only";
import { z } from "zod";
import { UpstreamError, fetchJson } from "./http";

export const WIKIDATA_API_URL = "https://www.wikidata.org/w/api.php";
export const SITELINKS_BATCH = 50;
export const SITELINKS_TIMEOUT_MS = 8_000;
/** Seconds of replication lag above which Wikimedia refuses the request (etiquette for background work). */
const MAXLAG = "5";

const QID = /^Q\d{1,12}$/;

const Response = z.object({
  error: z.object({ code: z.string() }).optional(),
  query: z
    .object({
      pages: z.array(
        z.object({
          title: z.string(),
          missing: z.boolean().optional(),
          pageprops: z.object({ "wb-sitelinks": z.string().regex(/^\d{1,4}$/).optional() }).optional(),
        }),
      ),
    })
    .optional(),
});

export function sitelinksUrl(ids: readonly string[]): string {
  const p = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "pageprops",
    ppprop: "wb-sitelinks",
    titles: ids.join("|"),
    maxlag: MAXLAG,
  });
  return `${WIKIDATA_API_URL}?${p}`;
}

/**
 * One answer → `{ Qid: count }`. Items without the page prop (no sitelinks) count 0; missing items are left out.
 * An API `error` (maxlag, ratelimited) throws, so nothing partial is cached.
 */
export function parseSitelinks(body: unknown): Record<string, number> {
  const parsed = Response.parse(body);
  if (parsed.error) throw new UpstreamError(`Wikidata: ${parsed.error.code.slice(0, 40)}`);
  if (!parsed.query) throw new UpstreamError("Wikidata: no query");
  const out: Record<string, number> = {};
  for (const p of parsed.query.pages) {
    if (p.missing || !QID.test(p.title)) continue;
    out[p.title] = Number(p.pageprops?.["wb-sitelinks"] ?? 0);
  }
  return out;
}

/** Requests of this instance run one after the other, also across concurrent lookups (API etiquette: serial). */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Sitelink counts for up to `ids.length` items, 50 per request, one request after the other (never parallel).
 * `deadline` (epoch ms): no new request starts after it, and the call throws (an incomplete map is not cached).
 * Throws on invalid ids, non-2xx, timeout or an API error.
 */
export async function fetchSitelinkCounts(
  ids: readonly string[],
  opts: { deadline?: number } = {},
): Promise<{ counts: Record<string, number>; requests: number; status: number; latencyMs: number }> {
  const unique = [...new Set(ids)];
  if (unique.some((q) => !QID.test(q))) throw new RangeError("wikidata id");
  const counts: Record<string, number> = {};
  let requests = 0;
  let latencyMs = 0;
  let status = 200;
  const expired = () => {
    const e = new Error("sitelinks deadline");
    e.name = "TimeoutError";
    return Object.assign(e, { units: requests, notSent: true });
  };
  for (let i = 0; i < unique.length; i += SITELINKS_BATCH) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) throw expired();
    try {
      const url = sitelinksUrl(unique.slice(i, i + SITELINKS_BATCH));
      // The wait in the queue counts against the deadline: checked again when the request would start.
      const r = await serial(() => {
        const left = opts.deadline === undefined ? SITELINKS_TIMEOUT_MS : opts.deadline - Date.now();
        if (left <= 0) throw expired();
        return fetchJson(url, { timeoutMs: Math.min(SITELINKS_TIMEOUT_MS, Math.max(1_000, left)) });
      });
      Object.assign(counts, parseSitelinks(r.body));
      requests += 1;
      latencyMs += r.latencyMs;
      status = r.status;
    } catch (err) {
      // The batches before plus this one (sent, whether it failed on the wire or in the answer); not when it never left.
      if (err !== null && typeof err === "object" && !(err as { notSent?: boolean }).notSent) Object.assign(err, { units: requests + 1 });
      throw err;
    }
  }
  return { counts, requests, status, latencyMs };
}
