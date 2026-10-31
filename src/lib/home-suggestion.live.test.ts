import { describe, it, vi } from "vitest";
import { getAirport } from "@/lib/integrations/airports";
import { parseSearchResponse } from "@/lib/integrations/open-meteo-geocoding";
import { pickHomeSuggestion } from "./home-suggestion";

vi.mock("server-only", () => ({}));

// Opt-in: hits the real public Open-Meteo geocoding API (read only). REAL_GEOCODE=1 npx vitest run <this file>
const live = process.env.REAL_GEOCODE ? describe : describe.skip;

live("home suggestion against the live geocoder", () => {
  for (const code of ["FRA", "MUC", "AGP", "FMM", "NRN", "HHN", "FKB", "BSL", "LHR", "JFK", "SXF", "BER", "DUS", "CGN", "SZG", "ZRH", "GVA", "PMI"]) {
    for (const lang of ["de", "en"] as const) {
      it(`${code} ${lang}`, async () => {
        const a = getAirport(code);
        if (!a) return void console.log(code, "not in dataset");
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(a.city)}&count=8&language=${lang}&format=json`);
        const places = parseSearchResponse(await r.json());
        const pick = pickHomeSuggestion(a, places, lang);
        console.log(`RESULT ${code} ${lang} city="${a.city}" ${a.country} ->`, pick ? JSON.stringify(pick) : "none", "| hits:", places.map((p) => `${p.name}/${p.countryCode}/${p.timezone ?? "-"}`).join("; "));
      }, 20000);
    }
  }
});
