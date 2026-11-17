import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { StopInfo, StopInfoLocale } from "@/lib/domain/stop-info";
import { runQuery } from "@/lib/integrations/overpass";
import {
  COMMONS_BATCH,
  EXTRACTS_BATCH,
  WIKIDATA_BATCH,
  chunk,
  fetchCommonsThumbs,
  fetchExtracts,
  fetchLabels,
  fetchStopEntities,
  type CommonsThumb,
  type Extract as WpExtract,
  type StopEntity,
} from "@/lib/integrations/wikimedia-stops";
import { buildStopInfo } from "@/lib/stop-info/build";
import { osmFacts, osmRefKey, osmRefOf, type OsmFacts, type OsmRef } from "@/lib/stop-info/match";
import { cacheKey, cached, type CacheCtx } from "../api-cache";

/**
 * One stop-info batch for a tour (docs/specs/city-tour-stop-info.md sections 2, 3 and 5): OSM tags (Overpass), Wikidata
 * entities, Wikipedia extracts in the owner's language with English fallback, labels, Commons thumbnails. Every call is
 * cached in api_cache and logged in api_calls; the batch has a 4 s budget on the request path and a long one in the
 * background (prefetch.ts). Stops whose pieces did not arrive in time get no entry ("unfinished") and are fetched again.
 * Nothing is guessed.
 *
 * Landmark fast path (spec, decisions 2026-11-15): `qids` maps stop keys to the Wikidata id already known from the
 * city's cached landmarks. Those stops do not need Overpass for their Wikidata link: with `tags: "unknown"` (request
 * path) Overpass is asked only for the other stops, and a stop with a known id becomes a `partial` card (no OSM opening
 * hours or website yet) instead of waiting for Overpass, which measured 27 s or 502 on the public instance. With
 * `tags: "all"` (background) Overpass is asked for every stop; if it fails, known-id stops still get partial cards.
 */
export const STOP_INFO_BUDGET_MS = 4000;
/** Request path with known-id stops: Overpass gets at most this, so their Wikidata/Wikipedia lookups keep their time. */
export const OVERPASS_REQUEST_CAP_MS = 1500;
const MIN_LEFT_MS = 500;
/**
 * Per Overpass instance for the by-id tags query (tiny, `[timeout:10]`): a hanging primary (overpass-api.de took the
 * whole 100 s client timeout when measured) must not use up the background budget before the mirrors are asked.
 * Three attempts (75 s) leave the Wikidata and Wikipedia steps time within BACKGROUND_BUDGET_MS (110 s).
 */
export const OVERPASS_ATTEMPT_MS = 25_000;
const DEFAULT_TIMEOUT_MS = 3000;
const DAY = 86400;

export type StopPoint = { key: string; cat?: string };
export type BatchOptions = { qids?: ReadonlyMap<string, string>; tags?: "unknown" | "all" };
export type BatchResult = { entries: StopInfo[]; unfinished: string[]; calls: number; storedAt: string };

const hash = (parts: readonly string[]) => createHash("sha256").update([...parts].sort().join("|")).digest("hex").slice(0, 32);

/** `offline`: a daily limit is used up, so only cached answers are used (spec 12, cache-only). */
type Clock = { deadline: number; now: () => number; offline?: boolean };
const timeLeft = (c: Clock) => c.deadline - c.now();
const timeoutFor = (c: Clock) => Math.min(DEFAULT_TIMEOUT_MS, timeLeft(c));

const TagsPayload = z.record(z.string(), z.record(z.string(), z.string()));
const EntitiesPayload = z.record(
  z.string(),
  z.object({
    sitelinks: z.object({ de: z.string().optional(), en: z.string().optional() }),
    image: z.string().nullable(),
    year: z.number().nullable(),
    architects: z.array(z.string()),
    heritage: z.string().nullable(),
    website: z.string().nullable(),
  }),
);
const LabelsPayload = z.record(z.string(), z.object({ de: z.string().optional(), en: z.string().optional() }));
const ExtractsPayload = z.record(z.string(), z.object({ title: z.string(), text: z.string() }));
const ThumbsPayload = z.record(
  z.string(),
  z.object({
    thumbUrl: z.string(),
    width: z.number(),
    height: z.number(),
    mime: z.string(),
    descriptionUrl: z.string(),
    licenseShortName: z.string().nullable(),
    licenseUrl: z.string().nullable(),
    artistHtml: z.string().nullable(),
  }),
);

const KEPT_TAGS = ["wikidata", "wikipedia", "website", "contact:website", "opening_hours"];

/** Overpass union by element ids; `out tags center` gives ways and relations a position, so none is dropped. */
export function osmTagsQuery(refs: readonly OsmRef[]): string {
  const ids = (t: OsmRef["type"]) => refs.filter((r) => r.type === t).map((r) => r.id);
  const part = (t: OsmRef["type"]) => (ids(t).length ? `${t}(id:${ids(t).join(",")});` : "");
  return `[out:json][timeout:10];(${part("node")}${part("way")}${part("relation")});out tags center;`;
}

type Got<T> = { ok: true; data: T; fetchedAt: string; network: boolean } | { ok: false; network: boolean };

async function call<T>(
  c: Clock,
  ctx: CacheCtx,
  o: { provider: "overpass" | "wikidata" | "wikipedia"; endpoint: string; key: string; ttl: number; schema: z.ZodType<T>; fetch: (timeoutMs: number) => Promise<{ data: T; status: number; latencyMs: number }> },
): Promise<Got<T>> {
  let network = false;
  const r = await cached<T>({
    provider: o.provider,
    endpoint: o.endpoint,
    key: o.key,
    ttlSeconds: o.ttl,
    schema: o.schema,
    ctx,
    fetchAllowed: () => !c.offline && timeLeft(c) >= MIN_LEFT_MS,
    fetcher: async () => {
      network = true;
      return o.fetch(Math.max(MIN_LEFT_MS, timeoutFor(c)));
    },
  });
  return r.ok ? { ok: true, data: r.data, fetchedAt: r.fetchedAt, network } : { ok: false, network };
}

export async function fetchStopInfoBatch(
  points: readonly StopPoint[],
  locale: StopInfoLocale,
  ctx: CacheCtx,
  clock: Clock = { deadline: Date.now() + STOP_INFO_BUDGET_MS, now: Date.now },
  opts: BatchOptions = {},
): Promise<BatchResult> {
  const unfinished = new Set<string>();
  const dates: string[] = [];
  let calls = 0;
  const note = <T,>(g: Got<T>): g is Got<T> & { ok: true } => {
    // A request that failed still reached the provider: it counts for the daily slot (settle, not release).
    if (g.network) calls++;
    if (g.ok) dates.push(g.fetchedAt);
    return g.ok;
  };

  const eligible = points.map((p) => ({ ...p, ref: osmRefOf(p.key) })).filter((p): p is StopPoint & { ref: OsmRef } => p.ref !== null);
  if (eligible.length === 0) return { entries: [], unfinished: [], calls: 0, storedAt: new Date(clock.now()).toISOString() };

  // 1. OSM tags in one Overpass query: for every stop ("all", background) or only for stops without a known Wikidata
  // id ("unknown", request path). A failed query never blocks the stops whose id is known.
  const known = opts.qids ?? new Map<string, string>();
  const asked = opts.tags === "all" ? eligible : eligible.filter((p) => !known.has(p.key));
  let tags: Record<string, Record<string, string>> | null = null;
  if (asked.length) {
    const refs = asked.map((p) => p.ref);
    const tagsRes = await call(clock, ctx, {
      provider: "overpass",
      endpoint: "stop_osm_tags",
      key: cacheKey("osm-tags", 1, { ids: hash(refs.map(osmRefKey)) }),
      ttl: 30 * DAY,
      schema: TagsPayload,
      fetch: async () => {
        const capped = opts.tags !== "all" && eligible.some((p) => known.has(p.key));
        const deadline = capped ? Math.min(clock.deadline, clock.now() + OVERPASS_REQUEST_CAP_MS) : clock.deadline;
        const r = await runQuery(osmTagsQuery(refs), { deadline, attemptTimeoutMs: OVERPASS_ATTEMPT_MS });
        const data: Record<string, Record<string, string>> = {};
        for (const e of r.elements) {
          const kept = Object.fromEntries(Object.entries(e.tags).filter(([k]) => KEPT_TAGS.includes(k)));
          data[osmRefKey({ type: e.type, id: e.id })] = kept;
        }
        return { data, status: r.status, latencyMs: r.latencyMs };
      },
    });
    if (note(tagsRes)) tags = tagsRes.data;
  }
  const askedKeys = new Set(asked.map((p) => p.key));
  const osm = new Map<string, OsmFacts>();
  const partial = new Set<string>();
  for (const p of eligible) {
    if (tags && askedKeys.has(p.key)) {
      const facts = osmFacts(tags[osmRefKey(p.ref)] ?? {});
      // OSM has no wikidata tag but the landmark set knows the id (same element): keep the known id.
      osm.set(p.key, facts.qid || !known.has(p.key) ? facts : { ...facts, qid: known.get(p.key)! });
    } else if (known.has(p.key)) {
      osm.set(p.key, { qid: known.get(p.key)!, wikipedia: null, website: null, openingHours: null });
      partial.add(p.key);
    } else unfinished.add(p.key); // no tags and no known id: nothing to go on yet
  }
  const usable = eligible.filter((p) => osm.has(p.key));
  if (usable.length === 0) return { entries: [], unfinished: [...unfinished], calls, storedAt: new Date(clock.now()).toISOString() };

  // 2. Wikidata entities, chunked.
  const qids = [...new Set([...osm.values()].map((f) => f.qid).filter((q): q is string => !!q))];
  const entities = new Map<string, StopEntity>();
  const missingEntities = new Set<string>();
  for (const ids of chunk(qids, WIKIDATA_BATCH)) {
    const g = await call(clock, ctx, {
      provider: "wikidata",
      endpoint: "stop_entities",
      key: cacheKey("wd-stop", 1, { ids: hash(ids) }),
      ttl: 30 * DAY,
      schema: EntitiesPayload,
      fetch: async (t) => {
        const r = await fetchStopEntities(ids, t);
        return { data: Object.fromEntries(r.entities), status: r.status, latencyMs: r.latencyMs };
      },
    });
    if (note(g)) for (const [k, v] of Object.entries(g.data)) entities.set(k, v);
    else ids.forEach((q) => missingEntities.add(q));
  }

  // 3. Which article per stop: the owner's language first, English as fallback ([Q1]).
  const titleFor = (key: string, lang: StopInfoLocale): string | null => {
    const f = osm.get(key);
    const e = f?.qid ? entities.get(f.qid) : undefined;
    if (e) return e.sitelinks[lang] ?? null;
    return !f?.qid && f?.wikipedia?.lang === lang ? f.wikipedia.title : null;
  };
  const extracts = new Map<string, { lang: StopInfoLocale; part: WpExtract }>();
  const failedExtracts = new Set<string>();
  const extractPass = async (lang: StopInfoLocale, keys: string[]) => {
    const want = new Map<string, string>(keys.map((k) => [k, titleFor(k, lang)]).filter((x): x is [string, string] => !!x[1]));
    const titles = [...new Set(want.values())];
    const got = new Map<string, WpExtract>();
    for (const part of chunk(titles, EXTRACTS_BATCH)) {
      const g = await call(clock, ctx, {
        provider: "wikipedia",
        endpoint: "stop_extracts",
        key: cacheKey("wp-extract", 1, { lang, titles: hash(part) }),
        ttl: 30 * DAY,
        schema: ExtractsPayload,
        fetch: async (t) => {
          const r = await fetchExtracts(lang, part, t);
          return { data: Object.fromEntries(r.extracts), status: r.status, latencyMs: r.latencyMs };
        },
      });
      if (note(g)) for (const [k, v] of Object.entries(g.data)) got.set(k, v);
      else for (const [k, t] of want) if (part.includes(t)) failedExtracts.add(k);
    }
    for (const [k, t] of want) {
      const hit = got.get(t);
      if (hit && !extracts.has(k)) extracts.set(k, { lang, part: hit });
    }
  };
  const keys = usable.map((p) => p.key);
  await extractPass(locale, keys);
  if (locale !== "en") await extractPass("en", keys.filter((k) => !extracts.has(k) && !failedExtracts.has(k)));

  // 4. Labels of architects and heritage designations.
  const labelIds = [...new Set([...entities.values()].flatMap((e) => [...e.architects, ...(e.heritage ? [e.heritage] : [])]))];
  const labels = new Map<string, { de?: string; en?: string }>();
  const failedLabels = new Set<string>();
  for (const ids of chunk(labelIds, WIKIDATA_BATCH)) {
    const g = await call(clock, ctx, {
      provider: "wikidata",
      endpoint: "stop_labels",
      key: cacheKey("wd-labels", 1, { ids: hash(ids) }),
      ttl: 90 * DAY,
      schema: LabelsPayload,
      fetch: async (t) => {
        const r = await fetchLabels(ids, t);
        return { data: Object.fromEntries(r.labels), status: r.status, latencyMs: r.latencyMs };
      },
    });
    if (note(g)) for (const [k, v] of Object.entries(g.data)) labels.set(k, v);
    else ids.forEach((q) => failedLabels.add(q));
  }

  // 5. Commons thumbnails (logged under wikidata, as the destination picture does).
  const files = [...new Set([...entities.values()].map((e) => e.image).filter((f): f is string => !!f))];
  const thumbs = new Map<string, CommonsThumb>();
  const failedFiles = new Set<string>();
  for (const names of chunk(files, COMMONS_BATCH)) {
    const g = await call(clock, ctx, {
      provider: "wikidata",
      endpoint: "stop_images",
      key: cacheKey("commons-info", 1, { titles: hash(names) }),
      ttl: 60 * DAY,
      schema: ThumbsPayload,
      fetch: async (t) => {
        const r = await fetchCommonsThumbs(names, t);
        return { data: Object.fromEntries(r.thumbs), status: r.status, latencyMs: r.latencyMs };
      },
    });
    if (note(g)) for (const [k, v] of Object.entries(g.data)) thumbs.set(k, v);
    else names.forEach((n) => failedFiles.add(n));
  }

  // 6. Cards. A stop whose entity, extract or image request failed is unfinished (fetched again on its next expand).
  // checkedAt: the oldest answer used (shown as "abgerufen am"); storedAt: this batch (drives the 30-day refresh, so a
  // card built from older cached answers is not fetched again on every expand).
  const storedAt = new Date(clock.now()).toISOString();
  const checkedAt = dates.length ? [...dates].sort()[0] : storedAt;
  const entries: StopInfo[] = [];
  for (const p of usable) {
    const f = osm.get(p.key)!;
    const e = f.qid ? entities.get(f.qid) ?? null : null;
    const needsFailedLabel = !!e && [...e.architects, ...(e.heritage ? [e.heritage] : [])].some((q) => failedLabels.has(q));
    if ((f.qid && missingEntities.has(f.qid)) || failedExtracts.has(p.key) || (e?.image && failedFiles.has(e.image)) || needsFailedLabel) {
      unfinished.add(p.key);
      continue;
    }
    const card = buildStopInfo({
        key: p.key,
        cat: p.cat,
        locale,
        checkedAt,
        storedAt,
        qid: e ? f.qid : null,
        osm: f,
        entity: e,
        extract: extracts.get(p.key) ?? null,
        thumb: e?.image ? thumbs.get(e.image) : undefined,
        labels,
      });
    entries.push(partial.has(p.key) ? { ...card, partial: true } : card);
  }
  return { entries, unfinished: [...unfinished], calls, storedAt };
}
