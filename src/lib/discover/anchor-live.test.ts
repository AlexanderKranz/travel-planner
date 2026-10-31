import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// cached(): run the fetcher directly (no database). Same contract as the real one: ok:false on a throw.
vi.mock("@/lib/server/api-cache", () => ({
  cacheKey: (e: string, v: number, p: Record<string, string | number>) => `${e}:v${v}:${JSON.stringify(p)}`,
  cached: async (o: { fetcher: () => Promise<{ data: unknown }> }) => {
    try {
      return { ok: true, data: (await o.fetcher()).data, fetchedAt: "x", stale: false, cache: "miss" };
    } catch {
      return { ok: false, error: "provider_error" };
    }
  },
}));

import { defaultVerifyDeps, resolveAnchor, type VerifyDeps } from "@/lib/server/discover/verify";

/**
 * Live check of step 1 against the real Open-Meteo geocoder. Off by default (network): LIVE_GEOCODING=1.
 * Each row: the anchor a model could plausibly return (local / English / German spelling) and the country.
 */
const IDEAS: { label: string; cc: string; anchors: string[] }[] = [
  { label: "Lisbon", cc: "PT", anchors: ["Lisboa", "Lisbon", "Lissabon"] },
  { label: "Seville", cc: "ES", anchors: ["Sevilla", "Seville"] },
  { label: "Florence", cc: "IT", anchors: ["Firenze", "Florence", "Florenz"] },
  { label: "Vienna", cc: "AT", anchors: ["Wien", "Vienna"] },
  { label: "Prague", cc: "CZ", anchors: ["Praha", "Prague", "Prag"] },
  { label: "Krakow", cc: "PL", anchors: ["Kraków", "Krakow", "Krakau"] },
  { label: "Palma", cc: "ES", anchors: ["Palma", "Palma de Mallorca"] },
  { label: "Marbella", cc: "ES", anchors: ["Marbella"] },
  { label: "Tenerife", cc: "ES", anchors: ["Santa Cruz de Tenerife", "Adeje", "Puerto de la Cruz"] },
  { label: "Faro", cc: "PT", anchors: ["Faro", "Albufeira", "Lagos"] },
  { label: "Crete", cc: "GR", anchors: ["Heraklion", "Irakleio", "Chania", "Iraklion"] },
  { label: "Santorini", cc: "GR", anchors: ["Fira", "Thira", "Oia"] },
  { label: "Funchal", cc: "PT", anchors: ["Funchal"] },
  { label: "Antalya", cc: "TR", anchors: ["Antalya"] },
  { label: "Belek", cc: "TR", anchors: ["Belek"] },
  { label: "Bad Fuessing", cc: "DE", anchors: ["Bad Füssing"] },
  { label: "Passau", cc: "DE", anchors: ["Passau"] },
  { label: "Reykjavik", cc: "IS", anchors: ["Reykjavík", "Reykjavik"] },
  { label: "Rome", cc: "IT", anchors: ["Roma", "Rome", "Rom"] },
  { label: "Venice", cc: "IT", anchors: ["Venezia", "Venice", "Venedig"] },
  { label: "Naples", cc: "IT", anchors: ["Napoli", "Naples", "Neapel"] },
  { label: "Copenhagen", cc: "DK", anchors: ["København", "Copenhagen", "Kopenhagen"] },
  { label: "Athens", cc: "GR", anchors: ["Athína", "Athens", "Athen"] },
  { label: "Nice", cc: "FR", anchors: ["Nice"] },
  { label: "Cologne", cc: "DE", anchors: ["Köln", "Cologne"] },
  { label: "Gran Canaria", cc: "ES", anchors: ["Las Palmas de Gran Canaria", "Maspalomas", "Las Palmas"] },
  { label: "Budapest", cc: "HU", anchors: ["Budapest"] },
  { label: "Split", cc: "HR", anchors: ["Split"] },
  { label: "Dubrovnik", cc: "HR", anchors: ["Dubrovnik"] },
  { label: "Salzburg", cc: "AT", anchors: ["Salzburg"] },
];

const live = process.env.LIVE_GEOCODING === "1" ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

live("anchor matching against the live geocoder", () => {
  it("resolves local, German and English spellings to the right country and reports the call count", { timeout: 900_000 }, async () => {
    let calls = 0;
    const deps: VerifyDeps = {
      ...defaultVerifyDeps,
      geocode: async (a, l, u) => {
        calls += 1;
        await sleep(350);
        return defaultVerifyDeps.geocode(a, l, u);
      },
      placeById: async (id, l) => {
        calls += 1;
        await sleep(350);
        return defaultVerifyDeps.placeById(id, l);
      },
    };
    const rows: string[] = [];
    let total = 0;
    let missed = 0;
    let failed = 0;
    for (const lang of ["de", "en"] as const) {
      for (const idea of IDEAS) {
        for (const anchor of idea.anchors) {
          total += 1;
          const r = await resolveAnchor({ name: anchor, anchor, cc: idea.cc, reason: "" }, lang, "live", deps);
          if (r.status === "failed") failed += 1;
          if (r.status === "not_found") {
            missed += 1;
            rows.push(`${lang} ${anchor} ${idea.cc}: DROPPED not_found`);
          }
          if (r.status === "ok" && r.place.countryCode !== idea.cc) rows.push(`${lang} ${anchor} ${idea.cc}: WRONG COUNTRY ${r.place.countryCode}`);
        }
      }
    }
    console.log(`TOTAL ${total} MISSED ${missed} (${Math.round((100 * missed) / total)} %) FAILED ${failed} GEOCODING CALLS ${calls} (${(calls / total).toFixed(2)} per idea)\n` + rows.join("\n"));
    expect(total).toBeGreaterThan(0);
    expect(rows.filter((r) => r.includes("WRONG COUNTRY"))).toEqual([]);
  });
});
