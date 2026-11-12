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

describe("resolvePlaceName: names that do not geocode as written (Open-Meteo shapes, checked live 2026-11-12)", () => {
  const at = (geoId: number, name: string, cc: string, code: string, lat: number, lon: number, pop: number | null): GeoPlace => ({
    ...p(geoId, name, cc, code, pop ?? 0), lat, lon, population: pop,
  });
  const messina = at(2524170, "Messina", "IT", "PPLA2", 38.19, 15.55, 220_000);
  // "La Valletta" in de/en: two Italian villages; in it: the Maltese capital first. "Valletta" in de/en: the capital.
  const villages = [at(11, "La Valletta", "IT", "PPL", 45.72, 9.37, null), at(12, "La Valletta", "IT", "PPL", 44.65, 7.3, null)];
  const capitalIt = at(2562305, "La Valletta", "MT", "PPLC", 35.9, 14.51, 6_444);
  const capital = { ...capitalIt, name: "Valletta" };
  /** Answers by "name:lang" (lower-case name), like the cached search. */
  const byQuery = (table: Record<string, GeoPlace[]>, calls: string[] = []): GeocodeDeps => ({
    geocode: async (name, lang) => {
      calls.push(`${name}:${lang}`);
      return { ok: true, data: table[`${name.toLowerCase()}:${lang}`] ?? [], fetchedAt: "2026-11-12T00:00:00.000Z", stale: false, cache: "hit" };
    },
    placeById: async (geoId) => (geoId === capital.geoId ? capital : null),
  });
  const table = {
    "messina:en": [messina],
    "messina:de": [messina],
    "la valletta:en": villages,
    "la valletta:de": villages,
    "la valletta:it": [capitalIt, ...villages],
    "valletta:en": [capital],
    "valletta:de": [capital],
  };

  it('"Messina (Sizilien)" with cc IT searches "Messina" and finds the PPLA2 in one call', async () => {
    const calls: string[] = [];
    const r = await resolvePlaceName("Messina (Sizilien)", "IT", "de", "u", byQuery(table, calls));
    expect(r).toMatchObject({ status: "ok", place: { geoId: messina.geoId, featureCode: "PPLA2" } });
    expect(calls).toEqual(["Messina:en"]);
  });

  it('"Messina (Sizilien), Italien" without a country is found too', async () => {
    const r = await resolvePlaceName("Messina (Sizilien), Italien", null, "de", "u", byQuery(table));
    expect(r).toMatchObject({ status: "ok", place: { geoId: messina.geoId } });
  });

  it('"La Valletta" with cc MT: the Italian search finds the Maltese capital (MT has no Open-Meteo language)', async () => {
    const calls: string[] = [];
    const r = await resolvePlaceName("La Valletta", "MT", "de", "u", byQuery(table, calls));
    expect(r).toMatchObject({ status: "ok", place: { geoId: capital.geoId, countryCode: "MT", name: "Valletta" } });
    expect(calls).toEqual(["La Valletta:en", "La Valletta:de", "La Valletta:it"]);
  });

  it('"La Valletta" with cc MT and no Italian hit: one retry without the article', async () => {
    const calls: string[] = [];
    const r = await resolvePlaceName("La Valletta", "MT", "de", "u", byQuery({ ...table, "la valletta:it": villages }, calls));
    expect(r).toMatchObject({ status: "ok", place: { geoId: capital.geoId } });
    expect(calls).toEqual(["La Valletta:en", "La Valletta:de", "La Valletta:it", "Valletta:en"]);
  });

  it('"La Valletta" without a country after Messina: the capital, not an Italian village', async () => {
    const calls: string[] = [];
    const near = { prev: { lat: messina.lat, lon: messina.lon } };
    const r = await resolvePlaceName("La Valletta", null, "de", "u", byQuery(table, calls), { near });
    expect(r).toMatchObject({ status: "ok", place: { geoId: capital.geoId } });
    expect(calls).toEqual(["La Valletta:en", "La Valletta:de", "Valletta:en"]);
  });

  it('"Valletta" finds the capital directly', async () => {
    const calls: string[] = [];
    expect(await resolvePlaceName("Valletta", "MT", "en", "u", byQuery(table, calls))).toMatchObject({ status: "ok", place: { geoId: capital.geoId } });
    expect(calls).toEqual(["Valletta:en"]);
  });

  it("without a reference point a name without its article is no guess (Las Palmas is not Palmas, BR)", async () => {
    const palmas = at(3474574, "Palmas", "BR", "PPLA", -10.2, -48.3, 200_000);
    const r = await resolvePlaceName("Las Palmas", null, "de", "u", byQuery({ "palmas:en": [palmas] }));
    expect(r).toEqual({ status: "not_found" });
  });

  it("a capital or seat beats a village of the same name in the any-country pass", async () => {
    const town = at(21, "Santa Cruz", "ES", "PPLA", 28.47, -16.25, 200_000);
    const hamlet = at(22, "Santa Cruz", "PT", "PPL", 32.69, -16.79, 5_000); // nearer to Funchal
    const near = { prev: { lat: 32.65, lon: -16.91 } };
    expect(await resolvePlaceName("Santa Cruz", null, "de", "u", byQuery({ "santa cruz:en": [hamlet, town] }), { near })).toMatchObject({
      status: "ok",
      place: { geoId: 21 },
    });
  });

  it("a failed retry keeps the pick made before it", async () => {
    const deps: GeocodeDeps = {
      geocode: async (name, lang) =>
        name === "Valletta" ? { ok: false, error: "provider_error" } : { ok: true, data: (table as Record<string, GeoPlace[]>)[`${name.toLowerCase()}:${lang}`] ?? [], fetchedAt: "x", stale: false, cache: "hit" },
      placeById: async () => null,
    };
    expect(await resolvePlaceName("La Valletta", null, "de", "u", deps)).toMatchObject({ status: "ok", place: { countryCode: "IT" } });
  });

  it("one place under two names: the search that has the wanted name counts (Genoa en, Genua de)", async () => {
    const genoa = at(3176219, "Genoa", "IT", "PPLA", 44.41, 8.93, 580_000);
    const r = await resolvePlaceName("Genua", null, "de", "u", byQuery({ "genua:en": [genoa], "genua:de": [{ ...genoa, name: "Genua" }] }));
    expect(r).toMatchObject({ status: "ok", place: { geoId: 3176219, name: "Genua" } });
  });

  it("an article-less namesake from an earlier search is held to the route radius too", async () => {
    const palmas = at(3474574, "Palmas", "BR", "PPLA", -10.2, -48.3, 200_000);
    const hamlet = at(31, "Las Palmas", "MX", "PPL", 20.0, -100.0, 50);
    // The full-name search itself returns "Palmas": without a reference point it must not win.
    expect(await resolvePlaceName("Las Palmas", null, "de", "u", byQuery({ "las palmas:en": [palmas, hamlet] }))).toMatchObject({
      status: "ok",
      place: { geoId: 31 },
    });
    // With a reference far from Brazil, the full-name match (fallback beyond range) still wins over Palmas.
    const near = { prev: { lat: 28.1, lon: -15.4 } };
    expect(await resolvePlaceName("Las Palmas", null, "de", "u", byQuery({ "las palmas:en": [palmas, hamlet] }), { near })).toMatchObject({
      status: "ok",
      place: { geoId: 31 },
    });
  });

  it("never more than 4 searches for one cold name", async () => {
    const calls: string[] = [];
    await resolvePlaceName("La Nowhere", "PT", "de", "u", byQuery({}, calls), { near: { prev: { lat: 0, lon: 0 } } });
    expect(calls).toHaveLength(4);
  });
});
