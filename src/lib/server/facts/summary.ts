import "server-only";
import { z } from "zod";
import type { DestinationSummary, Fact, FactsCtx } from "@/lib/domain/facts";
import type { Trip } from "@/lib/domain/trip";
import { fetchSummary } from "@/lib/integrations/wikivoyage";
import { cacheKey, cached } from "../api-cache";
import { geoDestination, unavailable } from "./common";

const summarySchema = z
  .object({ title: z.string(), extract: z.string(), url: z.string(), lang: z.string() })
  .nullable();

export async function getSummaryFacts(trip: Trip, ctx: FactsCtx): Promise<Fact<DestinationSummary>> {
  try {
    const dest = geoDestination(trip);
    if (!dest) return unavailable("no_location");
    const lang = ctx.locale === "de" ? "de" : "en";
    const res = await cached({
      provider: "wikivoyage",
      endpoint: "summary",
      key: cacheKey("summary", 1, { lang, geo: dest.geoId }),
      // Spec wants 7 d for "not found"; cached() has one TTL per call, so both use 30 d (see research doc).
      ttlSeconds: 30 * 86400,
      schema: summarySchema,
      ctx,
      fetcher: async () => {
        const r = await fetchSummary(dest.lat, dest.lon, dest.placeName, lang);
        return { data: r.summary, status: r.status, latencyMs: r.latencyMs };
      },
    });
    if (!res.ok) return unavailable("provider_error", "wikivoyage");
    if (!res.data) return unavailable("not_found", "wikivoyage");
    return {
      status: "ok",
      data: res.data,
      source: "wikivoyage",
      sourceUrl: res.data.url,
      fetchedAt: res.fetchedAt,
      stale: res.stale,
    };
  } catch {
    return unavailable("provider_error", "wikivoyage");
  }
}
