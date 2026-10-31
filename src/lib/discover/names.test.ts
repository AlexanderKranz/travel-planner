import { describe, expect, it } from "vitest";
import type { GeoPlace } from "@/lib/domain/geo";
import { DUPLICATE_KM, foldName, isDuplicate, kindOf, pickAnchorPlace } from "./names";

const place = (o: Partial<GeoPlace>): GeoPlace => ({
  geoId: 1,
  name: "Marbella",
  featureCode: "PPLA2",
  countryCode: "ES",
  admin1: "Andalusia",
  lat: 36.51,
  lon: -4.88,
  timezone: "Europe/Madrid",
  population: 140000,
  suggestedKind: "city",
  ...o,
});

describe("foldName", () => {
  it("folds accents, case, spaces and sharp s", () => {
    expect(foldName("  Málaga ")).toBe("malaga");
    expect(foldName("Gießen")).toBe("giessen");
    expect(foldName("São   Paulo")).toBe("sao paulo");
  });
});

describe("pickAnchorPlace (step 1)", () => {
  it("keeps populated places of the stated country whose folded name equals the anchor", () => {
    const r = [place({ geoId: 1 }), place({ geoId: 2, name: "Marbella Hills", featureCode: "PPLX" })];
    expect(pickAnchorPlace(r, "marbella", "es")?.geoId).toBe(1);
  });
  it("E5: a wrong country code drops the idea", () => {
    expect(pickAnchorPlace([place({ name: "Lisboa", countryCode: "PT" })], "Lisboa", "ES")).toBeNull();
    expect(pickAnchorPlace([place({ name: "Lisboa", countryCode: "PT" })], "Lisboa", "PT")).not.toBeNull();
  });
  it("ignores regions and other non-PPL features", () => {
    expect(pickAnchorPlace([place({ featureCode: "ADM1" })], "Marbella", "ES")).toBeNull();
    expect(pickAnchorPlace([place({ featureCode: "ISL" })], "Marbella", "ES")).toBeNull();
  });
  it("requires the exact folded name (no partial matches)", () => {
    expect(pickAnchorPlace([place({ name: "Marbella del Sol" })], "Marbella", "ES")).toBeNull();
  });
  it("on a tie takes the highest population (null counts as 0)", () => {
    const r = [place({ geoId: 1, population: null }), place({ geoId: 2, population: 400000 }), place({ geoId: 3, population: 1000 })];
    expect(pickAnchorPlace(r, "Marbella", "ES")?.geoId).toBe(2);
  });
  it("nothing found or empty anchor -> null", () => {
    expect(pickAnchorPlace([], "Marbella", "ES")).toBeNull();
    expect(pickAnchorPlace([place({})], "  ", "ES")).toBeNull();
  });
});

describe("kindOf (D8)", () => {
  it("name equal to the anchor (folded) is a city", () => {
    expect(kindOf("Málaga", "Malaga")).toBe("city");
  });
  it("E5: Costa del Sol / Marbella and Mallorca / Palma are regions", () => {
    expect(kindOf("Costa del Sol", "Marbella")).toBe("region");
    expect(kindOf("Mallorca", "Palma")).toBe("region");
  });
});

describe("isDuplicate", () => {
  const marbella = { geoId: 1, lat: 36.51, lon: -4.88 };
  it("same geoId", () => expect(isDuplicate({ ...marbella }, [marbella])).toBe(true));
  it(`within ${DUPLICATE_KM} km (Fuengirola is about 25 km from Marbella)`, () => {
    expect(isDuplicate({ geoId: 2, lat: 36.54, lon: -4.62 }, [marbella])).toBe(true);
  });
  it("Málaga is about 50 km away: not a duplicate", () => {
    expect(isDuplicate({ geoId: 3, lat: 36.72, lon: -4.42 }, [marbella])).toBe(false);
  });
  it("no others", () => expect(isDuplicate(marbella, [])).toBe(false));
});
