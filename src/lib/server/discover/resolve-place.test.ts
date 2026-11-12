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

  it("with a country given, a namesake elsewhere counts only within 500 km of the route (#188)", async () => {
    const at = (geoId: number, name: string, cc: string, lat: number, lon: number, pop = 100) => ({ ...p(geoId, name, cc, "PPL", pop), lat, lon });
    const wienAT = at(1, "Wien", "AT", 48.21, 16.37, 1_700_000);
    const wienUS = at(4, "Wien", "US", 39.74, -91.0, 300);
    const near = { prev: { lat: 48.31, lon: 14.29 } }; // Linz: Wien AT is about 150 km away
    // the DE namesake wins inside the country
    const r = await resolvePlaceName("Wien", "DE", "de", "u", deps({ en: [wienAT, at(2, "Wien", "DE", 51, 10, 3)], de: [] }), { near });
    expect(r).toMatchObject({ status: "ok", place: { geoId: 2 } });
    // a wrong country hint: the near namesake in another country is taken
    expect(await resolvePlaceName("Wien", "DE", "de", "u", deps({ en: [wienAT, wienUS] }), { near })).toMatchObject({ status: "ok", place: { geoId: 1 } });
    // only a far namesake, or no reference point: not found instead of a guess
    expect(await resolvePlaceName("Wien", "DE", "de", "u", deps({ en: [wienUS] }), { near })).toEqual({ status: "not_found" });
    expect(await resolvePlaceName("Wien", "DE", "de", "u", deps({ en: [wienAT] }))).toEqual({ status: "not_found" });
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

  it("without a country the largest exact match of ALL searches wins, not the first language's", async () => {
    const r = await resolvePlaceName("Cartagena", null, "en", "u", deps({ en: [p(1, "Cartagena", "ES", "PPL", 200_000)], de: [p(2, "Cartagena", "CO", "PPL", 1_000_000)] }));
    expect(r).toMatchObject({ status: "ok", place: { geoId: 2 } });
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
