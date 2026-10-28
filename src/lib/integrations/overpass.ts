/**
 * Overpass API (OpenStreetMap data, ODbL 1.0, keyless).
 * Docs: https://wiki.openstreetmap.org/wiki/Overpass_API and https://dev.overpass-api.de/overpass-doc/en/
 * (checked 2026-10-28). Etiquette: descriptive User-Agent, <= 2 slots per IP, no parallel bursts.
 * Verified live 2026-10-28 (see docs/research/phase-2-sources.md): the public instance was slow that night,
 * 37-66 s even for a trivial query (the `[timeout:25]` covers query execution, not the slot queue), one 502,
 * and a query that timed out answers HTTP 200 with an empty `elements` array plus a `remark`
 * containing "runtime error". parseElements() therefore treats any runtime-error remark as a failure.
 */
import "server-only";
import { z } from "zod";
import { HttpError, UpstreamError, postForm } from "./http";

export const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const OVERPASS_CLIENT_TIMEOUT_MS = 45_000;

export type RawOsmElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
};

const element = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.number().int(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).default({}),
});
const response = z.object({ elements: z.array(element), remark: z.string().optional() });

/** One `nwr` line per filter; every line also requires a name. Filters look like `["leisure"="golf_course"]`. */
export function buildQuery(
  filters: readonly string[],
  center: { lat: number; lon: number },
  radiusM: number,
): string {
  const around = `(around:${Math.round(radiusM)},${center.lat.toFixed(5)},${center.lon.toFixed(5)})`;
  const lines = filters.map((f) => `  nwr${f}["name"]${around};`).join("\n");
  return `[out:json][timeout:25];\n(\n${lines}\n);\nout center tags 150;`;
}

export function parseElements(body: unknown): RawOsmElement[] {
  const parsed = response.parse(body);
  if (parsed.remark && /runtime error|timed out|out of memory/i.test(parsed.remark)) {
    throw new UpstreamError(`Overpass: ${parsed.remark.slice(0, 120)}`);
  }
  const out: RawOsmElement[] = [];
  for (const e of parsed.elements) {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    out.push({ type: e.type, id: e.id, lat, lon, tags: e.tags });
  }
  return out;
}

/** Single query, no retries (429/504 are returned as HttpError so cached() can serve stale). */
export async function runQuery(
  query: string,
): Promise<{ elements: RawOsmElement[]; status: number; latencyMs: number }> {
  const url = process.env.OVERPASS_URL?.trim() || DEFAULT_OVERPASS_URL;
  const r = await postForm(url, { data: query }, { timeoutMs: OVERPASS_CLIENT_TIMEOUT_MS });
  return { elements: parseElements(r.body), status: r.status, latencyMs: r.latencyMs };
}

export { HttpError };
