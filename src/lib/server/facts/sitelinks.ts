import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { fetchSitelinkCounts } from "@/lib/integrations/wikidata-sitelinks";
import { cacheKey, cached, type CacheCtx, type CachedResult } from "../api-cache";

/**
 * Cached Wikidata sitelink counts (the prominence signal of places, issue #172): `wikidata/sitelinks`, 90 days,
 * logged in api_calls with one unit per request of 50 ids. Used by the city tour landmarks and by the interest places
 * of trips (`rankCandidates` with `sitelinks`). Never inline Overpass; the counts themselves take ~250 ms per 50 ids.
 */
export const SITELINKS_TTL_SECONDS = 90 * 86400;
/** Ids looked up per interest lookup (10 requests); the nearest ones when there are more. */
export const MAX_SITELINK_IDS = 500;
/** Time the counts may add to a place lookup before it ranks without them. */
export const SITELINKS_BUDGET_MS = 15_000;

const SitelinksSchema = z.record(z.string().regex(/^Q\d{1,12}$/), z.number().int().min(0));

/** 16 hex characters of sha256 over the sorted, unique ids. */
export function idsHash(ids: readonly string[]): string {
  return createHash("sha256").update([...new Set(ids)].sort().join(",")).digest("hex").slice(0, 16);
}

/** Key of a set of ids (trip interest places): `sitelinks:v1:ids=<hash>;n=<count>`. */
export const idsSitelinksKey = (ids: readonly string[]) => cacheKey("sitelinks", 1, { ids: idsHash(ids), n: new Set(ids).size });

/** Counts for `ids` under `key`. `deadline` null = cache only. Never throws (cached() classifies failures). */
export function cachedSitelinks(opts: {
  key: string;
  ids: readonly string[];
  ctx: CacheCtx;
  deadline: number | null;
}): Promise<CachedResult<Record<string, number>>> {
  const { key, ids, ctx, deadline } = opts;
  return cached({
    provider: "wikidata",
    endpoint: "sitelinks",
    key,
    ttlSeconds: SITELINKS_TTL_SECONDS,
    schema: SitelinksSchema,
    ctx,
    fetchAllowed: () => deadline !== null,
    fetcher: async () => {
      const r = await fetchSitelinkCounts(ids, { deadline: deadline ?? Date.now() });
      return { data: r.counts, status: r.status, latencyMs: r.latencyMs, units: r.requests };
    },
  });
}
