import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../api-cache", () => ({ cacheKey: () => "k", cached: vi.fn() }));

import type { GeoPlace } from "@/lib/domain/geo";
import { pickNamedPlace } from "@/lib/discover/names";
import { resolvePlaceName, type GeocodeDeps } from "./resolve-place";

const p = (geoId: number, name: string, cc: string, featureCode = "PPL", population = 100): GeoPlace => ({
  geoId, name, featureCode, countryCode: cc, admin1: null, lat: 1, lon: 2, timezone: null, population, suggestedKind: "city",
});
const deps = (byLang: Record<string, GeoPlace[]>, calls: string[] = [], local: Record<number, string> = {}): GeocodeDeps => ({
  geocode: async (name, lang) => {
    calls.push(`${name}:${lang}`);
    return { ok: true, data: byLang[lang] ?? [], fetchedAt: "2026-11-11T00:00:00.000Z", stale: false, cache: "hit" };
  },
  placeById: async (geoId, lang) => (local[geoId] ? { ...p(geoId, local[geoId], "AT"), name: local[geoId], admin1: lang } : null),
});

describe("resolvePlaceName (port-places [P1])", () => {
  it("the country's populated place by exact name, English first", async () => {
    const calls: string[] = [];
    const r = await resolvePlaceName("Melk", "AT", "de", "u", deps({ en: [p(1, "Melk", "AT"), p(2, "Melk", "DE", "PPL", 5)] }, calls));
    expect(r).toMatchObject({ status: "ok", place: { geoId: 1 } });
    expect(calls).toEqual(["Melk:en"]);
  });

  it("a hit in another language than the plan's is read again by id for the localized name", async () => {
    const r = await resolvePlaceName("Vienna", "AT", "de", "u", deps({ en: [p(2761369, "Vienna", "AT", "PPLC")] }, [], { 2761369: "Wien" }));
    expect(r.status === "ok" && r.place.name).toBe("Wien");
  });

  it("English, then German, then the country's language", async () => {
    const calls: string[] = [];
    const r = await resolvePlaceName("Lisboa", "PT", "en", "u", deps({ pt: [p(9, "Lisboa", "PT", "PPLC")] }, calls));
    expect(r.status).toBe("ok");
    expect(calls).toEqual(["Lisboa:en", "Lisboa:de", "Lisboa:pt"]);
  });

  it("falls back to an exact name in any country, the largest population first (a cruise leaves the destination's country)", async () => {
    const calls: string[] = [];
    const r = await resolvePlaceName("Wien", "DE", "de", "u", deps({ en: [p(1, "Wien", "AT", "PPLC", 1_700_000), p(2, "Wien", "DE", "PPL", 3)], de: [] }, calls));
    // the DE namesake wins inside the country
    expect(r).toMatchObject({ status: "ok", place: { geoId: 2 } });
    const only = await resolvePlaceName("Wien", "DE", "de", "u", deps({ en: [p(1, "Wien", "AT", "PPLC", 1_700_000), p(3, "Wien", "CH", "PPL", 50)] }));
    expect(only).toMatchObject({ status: "ok", place: { geoId: 1 } });
  });

  it("without any country only the any-country pass runs, and it needs just English and German", async () => {
    const calls: string[] = [];
    const r = await resolvePlaceName("Linz", null, "de", "u", deps({ de: [p(5, "Linz", "AT", "PPLA", 200_000)] }, calls));
    expect(r).toMatchObject({ status: "ok", place: { geoId: 5 } });
    expect(calls).toEqual(["Linz:en", "Linz:de"]);
  });

  it("the any-country pass takes populated places only, exact names only", async () => {
    expect(pickNamedPlace([p(1, "Melk", "AT", "ADM2")], "Melk")).toBeNull();
    expect(pickNamedPlace([p(1, "Melk an der Donau", "AT", "PPL")], "Melk")).toBeNull();
    expect((await resolvePlaceName("Melk", "AT", "de", "u", deps({ en: [p(1, "Melk", "AT", "ADM2")] }))).status).toBe("not_found");
  });

  it("anyCountry: false keeps the country a hard rule (destination ideas)", async () => {
    const strict = await resolvePlaceName("Wien", "DE", "de", "u", deps({ en: [p(1, "Wien", "AT", "PPLC")] }), { anyCountry: false });
    expect(strict.status).toBe("not_found");
  });

  it("a failed call is a failure, never not found", async () => {
    const down: GeocodeDeps = { geocode: async () => ({ ok: false, error: "provider_error" }), placeById: async () => null };
    expect(await resolvePlaceName("Wien", "AT", "de", "u", down)).toEqual({ status: "failed" });
  });
});
