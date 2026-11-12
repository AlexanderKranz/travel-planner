import { describe, expect, it } from "vitest";
import type { GeoPlace } from "@/lib/domain/geo";
import { cleanPlaceName, featureRank, pickDestinationPlace, stripLeadingArticle } from "./place-name";

const place = (geoId: number, name: string, cc: string, featureCode = "PPL", population: number | null = 100): GeoPlace => ({
  geoId, name, featureCode, countryCode: cc, admin1: null, lat: 0, lon: 0, timezone: null, population, suggestedKind: "city",
});

describe("cleanPlaceName", () => {
  it("drops a parenthetical and keeps the first of several parts", () => {
    expect(cleanPlaceName("Messina (Sizilien)")).toBe("Messina");
    expect(cleanPlaceName("  Messina (Sizilien), Italien ")).toBe("Messina");
    expect(cleanPlaceName("Civitavecchia (Rom)")).toBe("Civitavecchia");
    expect(cleanPlaceName("Bozen / Bolzano")).toBe("Bozen");
    expect(cleanPlaceName("Palma, Mallorca")).toBe("Palma");
  });
  it("leaves plain names and falls back to the input when nothing would remain", () => {
    expect(cleanPlaceName("Frankfurt am Main")).toBe("Frankfurt am Main");
    expect(cleanPlaceName("Stratford-upon-Avon")).toBe("Stratford-upon-Avon");
    expect(cleanPlaceName("(Sizilien)")).toBe("(Sizilien)");
  });
});

describe("stripLeadingArticle", () => {
  it("strips the listed articles only", () => {
    expect(stripLeadingArticle("La Valletta")).toBe("Valletta");
    expect(stripLeadingArticle("L'Aquila")).toBe("Aquila");
    expect(stripLeadingArticle("El Puerto")).toBe("Puerto");
    expect(stripLeadingArticle("Las Palmas")).toBe("Palmas");
    expect(stripLeadingArticle("Den Haag")).toBeNull();
    expect(stripLeadingArticle("Lanzarote")).toBeNull();
    expect(stripLeadingArticle("La ")).toBeNull();
  });
});

describe("featureRank", () => {
  it("capital > seat > other populated place > anything else", () => {
    expect(featureRank("PPLC")).toBe(3);
    expect(featureRank("PPLA2")).toBe(2);
    expect(featureRank("PPL")).toBe(1);
    expect(featureRank("PPLX")).toBe(1);
    expect(featureRank("ADM1")).toBe(0);
  });
});

describe("pickDestinationPlace (destination from the first port)", () => {
  it("an exact folded name, populated places only", () => {
    const r = [place(1, "Barcelona", "ES", "PPLA", 1_600_000), place(2, "Barcelona", "VE", "PPLA", 400_000), place(3, "Barcelona", "ES", "ADM2")];
    expect(pickDestinationPlace(r, ["barcelona"])?.geoId).toBe(1);
    expect(pickDestinationPlace([place(4, "Barceloneta", "ES")], ["Barcelona"])).toBeNull();
  });
  it("with a country only that country counts", () => {
    const r = [place(1, "Barcelona", "ES", "PPLA", 1_600_000), place(2, "Barcelona", "VE", "PPLA", 400_000)];
    expect(pickDestinationPlace(r, ["Barcelona"], "ve")?.geoId).toBe(2);
    expect(pickDestinationPlace(r, ["Barcelona"], "PT")).toBeNull();
  });
  it("the higher feature rank wins before population; several spellings compete", () => {
    const villages = [place(11, "La Valletta", "IT", "PPL", 5_000), place(12, "La Valletta", "IT", "PPL", null)];
    const capital = place(13, "Valletta", "MT", "PPLC", 6_000);
    expect(pickDestinationPlace([...villages, capital], ["La Valletta", "Valletta"])?.geoId).toBe(13);
    expect(pickDestinationPlace([place(1, "Messina", "IT", "PPL", 999_999), place(2, "Messina", "IT", "PPLA2", 220_000)], ["Messina"])?.geoId).toBe(2);
  });
});
