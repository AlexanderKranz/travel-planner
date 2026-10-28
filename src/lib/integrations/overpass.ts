/**
 * Overpass API (OpenStreetMap data, ODbL 1.0, keyless).
 * Docs: https://wiki.openstreetmap.org/wiki/Overpass_API and https://dev.overpass-api.de/overpass-doc/en/
 * (checked 2026-10-28). Etiquette: descriptive User-Agent, <= 2 slots per IP, no parallel bursts.
 * Verified live 2026-10-28 (see docs/research/phase-2-sources.md): the public instance was slow that night,
 * 23-66 s even for a trivial query (the `[timeout]` covers query execution, not the slot queue), one 502,
 * and a query that timed out answers HTTP 200 with an empty `elements` array plus a `remark`
 * containing "runtime error". parseElements() therefore treats any runtime-error remark as a failure.
 */
import "server-only";
import { z } from "zod";
import { HttpError, UpstreamError, postForm } from "./http";

export const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const FALLBACK_OVERPASS_URL = "https://maps.mail.ru/osm/tools/overpass/api/interpreter";
/** Per-attempt client timeout. The public instances queue for 20-60 s before a slot opens (measured 2026-10-28). */
export const OVERPASS_CLIENT_TIMEOUT_MS = 100_000;
/** Server-side execution limit sent in the query (`[timeout:N]`); the slot queue is not counted. */
export const OVERPASS_QUERY_TIMEOUT_S = 90;
/** Do not start a fallback attempt with less time left than this. */
const MIN_ATTEMPT_MS = 15_000;

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

/** Bounding box (south, west, north, east) around a centre; much cheaper for Overpass than `around`. The exact radius is applied in code. */
export function bboxAround(center: { lat: number; lon: number }, radiusM: number) {
  const km = radiusM / 1000;
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.max(0.05, Math.cos((center.lat * Math.PI) / 180)));
  const clampLat = (v: number) => Math.max(-90, Math.min(90, v));
  return {
    south: clampLat(center.lat - dLat),
    west: center.lon - dLon,
    north: clampLat(center.lat + dLat),
    east: center.lon + dLon,
  };
}

/**
 * One `nwr` line per filter; every line also requires a name. Filters look like `["leisure"="golf_course"]`.
 * Uses a bbox, not `around`: callers must drop results beyond the radius (rankCandidates does).
 */
export function buildQuery(
  filters: readonly string[],
  center: { lat: number; lon: number },
  radiusM: number,
): string {
  const b = bboxAround(center, radiusM);
  const box = `(${[b.south, b.west, b.north, b.east].map((v) => v.toFixed(5)).join(",")})`;
  const lines = filters.map((f) => `  nwr${f}["name"]${box};`).join("\n");
  return `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];\n(\n${lines}\n);\nout center tags 150;`;
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

/**
 * One query, primary instance first (`OVERPASS_URL` overrides it), then the mirror once on any failure
 * (timeout, 429, 5xx, runtime-error remark). Sequential, never parallel. `deadline` (epoch ms) caps the total time.
 */
export async function runQuery(
  query: string,
  opts: { deadline?: number } = {},
): Promise<{ elements: RawOsmElement[]; status: number; latencyMs: number }> {
  const primary = process.env.OVERPASS_URL?.trim() || DEFAULT_OVERPASS_URL;
  const urls = primary === FALLBACK_OVERPASS_URL ? [primary] : [primary, FALLBACK_OVERPASS_URL];
  let lastError: unknown;
  for (const [i, url] of urls.entries()) {
    const remaining = opts.deadline === undefined ? Infinity : opts.deadline - Date.now();
    if (i > 0 && remaining < MIN_ATTEMPT_MS) break;
    const timeoutMs = Math.max(1_000, Math.min(OVERPASS_CLIENT_TIMEOUT_MS, remaining));
    try {
      const r = await postForm(url, { data: query }, { timeoutMs });
      return { elements: parseElements(r.body), status: r.status, latencyMs: r.latencyMs };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export { HttpError };
