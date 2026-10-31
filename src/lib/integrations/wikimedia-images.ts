/**
 * Destination picture sources: Wikidata image claims and Wikimedia Commons file metadata (both keyless).
 * Docs: https://www.wikidata.org/w/api.php?action=help&modules=wbgetclaims,
 * https://www.mediawiki.org/wiki/API:Imageinfo, thumbnail steps https://www.mediawiki.org/wiki/Common_Parameters
 * and https://phabricator.wikimedia.org/T360589 (thumbnail widths limited to standard steps), UA policy
 * https://meta.wikimedia.org/wiki/User-Agent_policy (checked 2026-10-31).
 * Verified live 2026-10-31: `wbgetclaims&entity=Q4190&property=P948` returns "Passau-banner-s1.jpg" (rank normal);
 * Commons `prop=imageinfo&iiprop=extmetadata|size|url|mime` gives width/height/mime, `LicenseShortName`,
 * `LicenseUrl` and `Artist` (HTML, untrusted). Thumbnails: `.../thumb/b/b2/<name>/1920px-<name>` answers 200,
 * `1600px-` answers HTTP 400, so only the standard steps are used (see lib/facts/picture.ts).
 */
import "server-only";
import { z } from "zod";
import { commonsTitle, type CommonsFile } from "@/lib/facts/picture";
import { UpstreamError, fetchJson } from "./http";

const claim = z.object({
  rank: z.enum(["preferred", "normal", "deprecated"]).optional(),
  mainsnak: z.object({
    snaktype: z.string(),
    datavalue: z.object({ value: z.unknown() }).optional(),
  }),
});
const claimsResponse = z.object({
  error: z.object({ code: z.string() }).optional(),
  claims: z.record(z.string(), z.array(claim)).optional(),
});

const MAX_CANDIDATES = 3;

/** File names of a Commons-media property (P948 banner, P18 image): preferred first, deprecated dropped. */
export function parseCommonsClaims(body: unknown, property: string): string[] {
  const parsed = claimsResponse.parse(body);
  if (parsed.error) throw new UpstreamError(`Wikidata: ${parsed.error.code}`);
  const list = (parsed.claims?.[property] ?? []).filter((c) => c.rank !== "deprecated" && c.mainsnak.snaktype === "value");
  list.sort((a, b) => Number(b.rank === "preferred") - Number(a.rank === "preferred"));
  const names: string[] = [];
  for (const c of list) {
    const v = c.mainsnak.datavalue?.value;
    if (typeof v === "string" && v.length > 0 && v.length <= 240 && !v.includes("|") && !names.includes(v)) names.push(v);
  }
  return names.slice(0, MAX_CANDIDATES);
}

export async function fetchImageClaims(
  qid: string,
): Promise<{ banners: string[]; images: string[]; status: number; latencyMs: number }> {
  const one = (property: string) => {
    const params = new URLSearchParams({ action: "wbgetclaims", format: "json", entity: qid, property });
    return fetchJson(`https://www.wikidata.org/w/api.php?${params}`, { timeoutMs: 5000 });
  };
  const [b, i] = await Promise.all([one("P948"), one("P18")]);
  return {
    banners: parseCommonsClaims(b.body, "P948"),
    images: parseCommonsClaims(i.body, "P18"),
    status: Math.max(b.status, i.status),
    latencyMs: Math.max(b.latencyMs, i.latencyMs),
  };
}

const metaValue = z.object({ value: z.unknown() }).optional();
const imageinfo = z.object({
  width: z.number(),
  height: z.number(),
  mime: z.string(),
  url: z.string(),
  descriptionurl: z.string(),
  extmetadata: z
    .object({ LicenseShortName: metaValue, LicenseUrl: metaValue, Artist: metaValue })
    .partial()
    .optional(),
});
const commonsResponse = z.object({
  error: z.object({ code: z.string() }).optional(),
  query: z
    .object({
      pages: z.array(z.object({ title: z.string(), missing: z.boolean().optional(), imageinfo: z.array(imageinfo).optional() })),
    })
    .optional(),
});

const str = (v: { value?: unknown } | undefined): string | null => (typeof v?.value === "string" ? v.value : null);

/** Result keyed by the Commons title (`File:Name with spaces.jpg`). Missing files are simply absent. */
export function parseCommonsFiles(body: unknown): Map<string, CommonsFile> {
  const parsed = commonsResponse.parse(body);
  if (parsed.error) throw new UpstreamError(`Commons: ${parsed.error.code}`);
  const out = new Map<string, CommonsFile>();
  for (const p of parsed.query?.pages ?? []) {
    const info = p.imageinfo?.[0];
    if (p.missing || !info) continue;
    out.set(p.title, {
      title: p.title,
      mime: info.mime,
      width: info.width,
      height: info.height,
      url: info.url,
      descriptionUrl: info.descriptionurl,
      licenseShortName: str(info.extmetadata?.LicenseShortName),
      licenseUrl: str(info.extmetadata?.LicenseUrl),
      artistHtml: str(info.extmetadata?.Artist),
    });
  }
  return out;
}

export async function fetchCommonsFiles(
  names: string[],
): Promise<{ files: Map<string, CommonsFile>; status: number; latencyMs: number }> {
  if (names.length === 0) return { files: new Map(), status: 200, latencyMs: 0 };
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    titles: names.map(commonsTitle).join("|"),
    prop: "imageinfo",
    iiprop: "extmetadata|size|url|mime",
    iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist",
  });
  const r = await fetchJson(`https://commons.wikimedia.org/w/api.php?${params}`, { timeoutMs: 6000 });
  return { files: parseCommonsFiles(r.body), status: r.status, latencyMs: r.latencyMs };
}
