/**
 * Stop info sources (docs/specs/city-tour-stop-info.md section 3): Wikidata entities and labels, Wikipedia intro
 * extracts, Commons thumbnails. All keyless, batched to the API limits, sent with the app's User-Agent (`fetchJson`).
 * Docs: https://www.wikidata.org/w/api.php?action=help&modules=wbgetentities,
 * https://www.mediawiki.org/wiki/Extension:TextExtracts#API, https://www.mediawiki.org/wiki/API:Imageinfo.
 */
import "server-only";
import { z } from "zod";
import { commonsTitle } from "@/lib/facts/picture";
import { cleanQid } from "@/lib/stop-info/match";
import { UpstreamError, fetchJson } from "./http";

export const WIKIDATA_BATCH = 50;
export const EXTRACTS_BATCH = 20;
export const COMMONS_BATCH = 50;
export const STOP_THUMB_WIDTH = 330;

export const chunk = <T,>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// ---------- Wikidata entities ----------

export type StopEntity = {
  sitelinks: { de?: string; en?: string };
  image: string | null;
  year: number | null;
  architects: string[];
  heritage: string | null;
  website: string | null;
};

const snak = z.object({ snaktype: z.string(), datavalue: z.object({ value: z.unknown() }).optional() });
const claim = z.object({ rank: z.string().optional(), mainsnak: snak });
const entitiesResponse = z.object({
  error: z.object({ code: z.string() }).optional(),
  entities: z
    .record(
      z.string(),
      z.object({
        missing: z.unknown().optional(),
        sitelinks: z.record(z.string(), z.object({ title: z.string() })).optional(),
        claims: z.record(z.string(), z.array(claim)).optional(),
        labels: z.record(z.string(), z.object({ value: z.string() })).optional(),
      }),
    )
    .optional(),
});

/** Claim values of a property: preferred first, deprecated and no-value snaks dropped. */
function values(claims: Record<string, z.infer<typeof claim>[]> | undefined, p: string): unknown[] {
  const list = (claims?.[p] ?? []).filter((c) => c.rank !== "deprecated" && c.mainsnak.snaktype === "value");
  list.sort((a, b) => Number(b.rank === "preferred") - Number(a.rank === "preferred"));
  return list.map((c) => c.mainsnak.datavalue?.value);
}

const entityId = (v: unknown): string | null =>
  v && typeof v === "object" && "id" in v && typeof (v as { id: unknown }).id === "string" ? cleanQid((v as { id: string }).id) : null;

/** Year of a Wikidata time value with at least year precision (9); "+1147-00-00T00:00:00Z" → 1147. */
export function yearOf(v: unknown): number | null {
  if (!v || typeof v !== "object") return null;
  const { time, precision } = v as { time?: unknown; precision?: unknown };
  if (typeof time !== "string" || typeof precision !== "number" || precision < 9) return null;
  const m = /^([+-])(\d{1,6})-/.exec(time);
  if (!m) return null;
  const y = Number(m[2]) * (m[1] === "-" ? -1 : 1);
  return y >= -5000 && y <= 2100 && y !== 0 ? y : null;
}

export function parseStopEntities(body: unknown): Map<string, StopEntity> {
  const parsed = entitiesResponse.parse(body);
  if (parsed.error) throw new UpstreamError(`Wikidata: ${parsed.error.code}`);
  const out = new Map<string, StopEntity>();
  for (const [id, e] of Object.entries(parsed.entities ?? {})) {
    if (e.missing !== undefined || !cleanQid(id)) continue;
    const image = values(e.claims, "P18").find((v): v is string => typeof v === "string" && v.length <= 240 && !v.includes("|"));
    const site = values(e.claims, "P856").find((v): v is string => typeof v === "string");
    out.set(id, {
      sitelinks: { de: e.sitelinks?.dewiki?.title, en: e.sitelinks?.enwiki?.title },
      image: image ?? null,
      year: values(e.claims, "P571").map(yearOf).find((y): y is number => y !== null) ?? null,
      architects: [...new Set(values(e.claims, "P84").map(entityId).filter((x): x is string => !!x))].slice(0, 2),
      heritage: values(e.claims, "P1435").map(entityId).find((x): x is string => !!x) ?? null,
      website: site ?? null,
    });
  }
  return out;
}

const wikidataUrl = (params: Record<string, string>) =>
  `https://www.wikidata.org/w/api.php?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;

export async function fetchStopEntities(ids: readonly string[], timeoutMs: number) {
  const r = await fetchJson(
    wikidataUrl({ action: "wbgetentities", ids: ids.join("|"), props: "sitelinks|claims", sitefilter: "dewiki|enwiki" }),
    { timeoutMs },
  );
  return { entities: parseStopEntities(r.body), status: r.status, latencyMs: r.latencyMs };
}

/** Labels of the architect and heritage items, in de and en. */
export function parseLabels(body: unknown): Map<string, { de?: string; en?: string }> {
  const parsed = entitiesResponse.parse(body);
  if (parsed.error) throw new UpstreamError(`Wikidata: ${parsed.error.code}`);
  const out = new Map<string, { de?: string; en?: string }>();
  for (const [id, e] of Object.entries(parsed.entities ?? {})) {
    if (e.missing !== undefined) continue;
    out.set(id, { de: e.labels?.de?.value, en: e.labels?.en?.value });
  }
  return out;
}

export async function fetchLabels(ids: readonly string[], timeoutMs: number) {
  const r = await fetchJson(wikidataUrl({ action: "wbgetentities", ids: ids.join("|"), props: "labels", languages: "de|en" }), {
    timeoutMs,
  });
  return { labels: parseLabels(r.body), status: r.status, latencyMs: r.latencyMs };
}

// ---------- Wikipedia extracts ----------

export type Extract = { title: string; text: string };

const extractsResponse = z.object({
  error: z.object({ code: z.string() }).optional(),
  query: z
    .object({
      normalized: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      redirects: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      pages: z
        .array(
          z.object({
            title: z.string(),
            missing: z.boolean().optional(),
            extract: z.string().optional(),
            pageprops: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

/**
 * Intro extracts keyed by the REQUESTED title: normalisation and redirects are followed to the article that answered
 * (its title is returned). Disambiguation pages, missing pages and empty extracts are left out.
 */
export function parseExtracts(body: unknown, requested: readonly string[]): Map<string, Extract> {
  const parsed = extractsResponse.parse(body);
  if (parsed.error) throw new UpstreamError(`Wikipedia: ${parsed.error.code}`);
  const q = parsed.query;
  const pages = new Map<string, Extract>();
  for (const p of q?.pages ?? []) {
    if (p.missing || p.pageprops?.disambiguation !== undefined) continue;
    const text = p.extract?.trim();
    if (text) pages.set(p.title, { title: p.title, text });
  }
  const follow = (t: string, list: { from: string; to: string }[] | undefined) => list?.find((x) => x.from === t)?.to ?? t;
  const out = new Map<string, Extract>();
  for (const t of requested) {
    const hit = pages.get(follow(follow(t, q?.normalized), q?.redirects));
    if (hit) out.set(t, hit);
  }
  return out;
}

export async function fetchExtracts(lang: "de" | "en", titles: readonly string[], timeoutMs: number) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "extracts|pageprops",
    ppprop: "disambiguation",
    exintro: "1",
    explaintext: "1",
    exlimit: String(EXTRACTS_BATCH),
    redirects: "1",
    titles: titles.join("|"),
  });
  const r = await fetchJson(`https://${lang}.wikipedia.org/w/api.php?${params}`, { timeoutMs });
  return { extracts: parseExtracts(r.body, titles), status: r.status, latencyMs: r.latencyMs };
}

// ---------- Commons thumbnails ----------

export type CommonsThumb = {
  thumbUrl: string;
  width: number;
  height: number;
  mime: string;
  descriptionUrl: string;
  licenseShortName: string | null;
  licenseUrl: string | null;
  artistHtml: string | null;
};

const metaValue = z.object({ value: z.unknown() }).optional();
const commonsResponse = z.object({
  error: z.object({ code: z.string() }).optional(),
  query: z
    .object({
      normalized: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      pages: z
        .array(
          z.object({
            title: z.string(),
            missing: z.boolean().optional(),
            imageinfo: z
              .array(
                z.object({
                  thumburl: z.string().optional(),
                  thumbwidth: z.number().optional(),
                  thumbheight: z.number().optional(),
                  mime: z.string(),
                  descriptionurl: z.string(),
                  extmetadata: z.object({ LicenseShortName: metaValue, LicenseUrl: metaValue, Artist: metaValue }).partial().optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});
const str = (v: { value?: unknown } | undefined): string | null => (typeof v?.value === "string" ? v.value : null);

/** Thumbnails keyed by the Wikidata file name (`Name.jpg`, spaces as given), following Commons title normalisation. */
export function parseCommonsThumbs(body: unknown, names: readonly string[]): Map<string, CommonsThumb> {
  const parsed = commonsResponse.parse(body);
  if (parsed.error) throw new UpstreamError(`Commons: ${parsed.error.code}`);
  const byTitle = new Map<string, CommonsThumb>();
  for (const p of parsed.query?.pages ?? []) {
    const i = p.imageinfo?.[0];
    if (p.missing || !i?.thumburl || !i.thumbwidth || !i.thumbheight) continue;
    byTitle.set(p.title, {
      thumbUrl: i.thumburl,
      width: i.thumbwidth,
      height: i.thumbheight,
      mime: i.mime,
      descriptionUrl: i.descriptionurl,
      licenseShortName: str(i.extmetadata?.LicenseShortName),
      licenseUrl: str(i.extmetadata?.LicenseUrl),
      artistHtml: str(i.extmetadata?.Artist),
    });
  }
  const out = new Map<string, CommonsThumb>();
  for (const n of names) {
    const t = commonsTitle(n);
    const to = parsed.query?.normalized?.find((x) => x.from === t)?.to ?? t;
    const hit = byTitle.get(to);
    if (hit) out.set(n, hit);
  }
  return out;
}

export async function fetchCommonsThumbs(names: readonly string[], timeoutMs: number) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: String(STOP_THUMB_WIDTH),
    iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist",
    titles: names.map(commonsTitle).join("|"),
  });
  const r = await fetchJson(`https://commons.wikimedia.org/w/api.php?${params}`, { timeoutMs });
  return { thumbs: parseCommonsThumbs(r.body, names), status: r.status, latencyMs: r.latencyMs };
}
