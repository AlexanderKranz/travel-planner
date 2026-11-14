import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WMO_GROUPS, wmoGroup } from "./wmo";

describe("wmoGroup", () => {
  it("groups the WMO codes Open-Meteo uses", () => {
    expect([0, 1, 2, 3, 45, 51, 56, 61, 66, 71, 80, 85, 95, 99].map(wmoGroup)).toEqual([
      "clear", "mainlyClear", "partlyCloudy", "overcast", "fog", "drizzle", "freezingRain", "rain", "freezingRain", "snow", "showers", "snowShowers", "thunder", "thunder",
    ]);
    expect(wmoGroup(null)).toBeNull();
    expect(wmoGroup(42)).toBeNull();
  });

  it("every group has a label in de and en", () => {
    for (const loc of ["de", "en"]) {
      const codes = JSON.parse(readFileSync(join(__dirname, `../../../messages/${loc}.json`), "utf8")).tours.forecast.codes;
      for (const g of WMO_GROUPS) expect(codes, `${loc}: ${g}`).toHaveProperty(g);
    }
  });
});
