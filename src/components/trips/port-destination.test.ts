import { describe, expect, it } from "vitest";
import type { GeoPlace } from "@/lib/domain";
import { destinationForPort, type PortGeocode } from "./port-destination";

const place = (geoId: number, name: string, cc: string, featureCode: string, population: number | null, admin1: string | null = null): GeoPlace => ({
  geoId, name, featureCode, countryCode: cc, admin1, lat: 0, lon: 0, timezone: null, population, suggestedKind: "city",
});

const stub = (table: Record<string, GeoPlace[]>, calls: string[] = [], extra: Partial<Awaited<ReturnType<PortGeocode>>> = {}): PortGeocode =>
  async (q, lang) => {
    calls.push(`${q}:${lang}`);
    return { results: table[q.toLowerCase()] ?? [], unavailable: false, rateLimited: false, ...extra };
  };

const CODES = ["DE", "ES", "IT", "MT"];

describe("destinationForPort (first port of an upload)", () => {
  it("an exact match becomes a picked city, like the destination picker", async () => {
    const calls: string[] = [];
    const barcelona = place(3128760, "Barcelona", "ES", "PPLA", 1_600_000, "Katalonien");
    const d = await destinationForPort({ name: "Barcelona", cc: "ES" }, "de", CODES, stub({ barcelona: [place(9, "Barcelona", "VE", "PPLA", 400_000), barcelona] }, calls));
    expect(d).toEqual({
      mode: "geo",
      geoKind: "city",
      geoId: 3128760,
      placeName: "Barcelona",
      placeLabel: "Barcelona, Katalonien, Spanien",
      name: "Barcelona",
      radiusKm: null,
    });
    expect(calls).toEqual(["Barcelona:de"]);
  });

  it("searches the cleaned name; without a country the higher rank and population win", async () => {
    const calls: string[] = [];
    const d = await destinationForPort(
      { name: "Messina (Sizilien)" },
      "de",
      CODES,
      stub({ messina: [place(1, "Messina", "ZA", "PPL", 30_000), place(2524170, "Messina", "IT", "PPLA2", 220_000)] }, calls),
    );
    expect(d).toMatchObject({ mode: "geo", geoId: 2524170 });
    expect(calls).toEqual(["Messina:de"]);
  });

  it("with a country and no match there: one retry without the article", async () => {
    const calls: string[] = [];
    const villages = [place(11, "La Valletta", "IT", "PPL", null), place(12, "La Valletta", "IT", "PPL", null)];
    const d = await destinationForPort(
      { name: "La Valletta", cc: "MT" },
      "de",
      CODES,
      stub({ "la valletta": villages, valletta: [place(2562305, "Valletta", "MT", "PPLC", 6_444)] }, calls),
    );
    expect(d).toMatchObject({ mode: "geo", geoId: 2562305, name: "Valletta" });
    expect(calls).toEqual(["La Valletta:de", "Valletta:de"]);
  });

  it("nothing matching: the free-text destination as before (country kept when known)", async () => {
    expect(await destinationForPort({ name: "Anzeigename", cc: "MT" }, "de", CODES, stub({}))).toEqual({ mode: "freetext", name: "Anzeigename", countryCode: "MT" });
    expect(await destinationForPort({ name: "Atlantis", cc: "XX" }, "de", CODES, stub({}))).toEqual({ mode: "freetext", name: "Atlantis", countryCode: "" });
    // A namesake in another country than the port's is not taken.
    const other = stub({ barcelona: [place(9, "Barcelona", "VE", "PPLA", 400_000)] });
    expect(await destinationForPort({ name: "Barcelona", cc: "ES" }, "de", CODES, other)).toMatchObject({ mode: "freetext" });
  });

  it("without a country there is no article retry (Las Palmas is not Palmas, BR)", async () => {
    const calls: string[] = [];
    const d = await destinationForPort({ name: "Las Palmas" }, "de", CODES, stub({ palmas: [place(1, "Palmas", "BR", "PPLA", 200_000)] }, calls));
    expect(d).toMatchObject({ mode: "freetext", name: "Las Palmas" });
    expect(calls).toEqual(["Las Palmas:de"]);
  });

  it("a geocoder failure falls back to free text and never throws", async () => {
    const down: PortGeocode = async () => {
      throw new Error("500");
    };
    expect(await destinationForPort({ name: "Barcelona" }, "en", CODES, down)).toMatchObject({ mode: "freetext", name: "Barcelona" });
    expect(await destinationForPort({ name: "Barcelona" }, "en", CODES, stub({}, [], { unavailable: true }))).toMatchObject({ mode: "freetext" });
  });
});
