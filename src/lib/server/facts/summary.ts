import "server-only";
import { z } from "zod";
import type { DestinationSummary, Fact, FactsCtx } from "@/lib/domain/facts";
import type { Trip } from "@/lib/domain/trip";
import { fetchWikipediaSummary } from "@/lib/integrations/wikipedia";
import { fetchSummary } from "@/lib/integrations/wikivoyage";
import { cacheKey, cached } from "../api-cache";
import { geoDestination, unavailable } from "./common";

const summarySchema = z
  .object({
    title: z.string(),
    extract: z.string(),
    paragraphs: z.array(z.string()).optional(),
    url: z.string(),
    lang: z.string(),
  })
  .nullable();

/** Below this length the Wikivoyage intro is a one-liner; then the Wikipedia intro is used if it is longer. */
export const MIN_SUMMARY_CHARS = 400;

const TTL_SECONDS = 30 * 86400; // spec wants 7 d for "not found"; cached() has one TTL per call (see research doc)

export async function getSummaryFacts(trip: Trip, ctx: FactsCtx): Promise<Fact<DestinationSummary>> {
  try {
    const dest = geoDestination(trip);
    if (!dest) return unavailable("no_location");
    const lang = ctx.locale === "de" ? "de" : "en";
    const voyage = await cached({
      provider: "wikivoyage",
      endpoint: "summary",
      key: cacheKey("summary", 2, { lang, geo: dest.geoId }),
      ttlSeconds: TTL_SECONDS,
      schema: summarySchema,
      ctx,
      fetcher: async () => {
        const r = await fetchSummary(dest.lat, dest.lon, dest.placeName, lang);
        return { data: r.summary, status: r.status, latencyMs: r.latencyMs };
      },
    });

    const voyageText = voyage.ok ? voyage.data : null;
    let pedia: Awaited<ReturnType<typeof cached<DestinationSummary | null>>> | null = null;
    if (!voyageText || voyageText.extract.length < MIN_SUMMARY_CHARS) {
      pedia = await cached({
        provider: "wikipedia",
        endpoint: "summary",
        key: cacheKey("summary", 1, { lang, geo: dest.geoId }),
        ttlSeconds: TTL_SECONDS,
        schema: summarySchema,
        ctx,
        fetcher: async () => {
          const r = await fetchWikipediaSummary(dest.lat, dest.lon, dest.placeName, lang);
          return { data: r.summary, status: r.status, latencyMs: r.latencyMs };
        },
      });
    }

    const pediaText = pedia?.ok ? pedia.data : null;
    if (pedia?.ok && pediaText && pediaText.extract.length > (voyageText?.extract.length ?? 0)) {
      return {
        status: "ok",
        data: pediaText,
        source: "wikipedia",
        sourceUrl: pediaText.url,
        fetchedAt: pedia.fetchedAt,
        stale: pedia.stale,
      };
    }
    if (!voyage.ok) return unavailable("provider_error", "wikivoyage");
    if (!voyage.data) return unavailable("not_found", "wikivoyage");
    return {
      status: "ok",
      data: voyage.data,
      source: "wikivoyage",
      sourceUrl: voyage.data.url,
      fetchedAt: voyage.fetchedAt,
      stale: voyage.stale,
    };
  } catch {
    return unavailable("provider_error", "wikivoyage");
  }
}
