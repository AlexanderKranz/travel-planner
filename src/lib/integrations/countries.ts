/**
 * Country facts from the bundled dataset src/data/countries.json (built by scripts/countries/build.mjs,
 * see src/data/README.md). In-memory, no network. Server-only by convention (dataset is ~40 KB).
 */
import "server-only";
import { z } from "zod";
import raw from "@/data/countries.json";

const country = z.object({
  nameEn: z.string(),
  capital: z.array(z.string()),
  currencies: z.array(z.object({ code: z.string(), symbol: z.string().optional() })),
  languages: z.array(z.object({ code: z.string(), nameEn: z.string() })),
  callingCodes: z.array(z.string()),
  drivingSide: z.enum(["left", "right"]),
});
export type CountryRecord = z.infer<typeof country>;

const file = z.object({
  source: z.string(),
  fetchedAt: z.string(),
  countries: z.record(z.string(), country),
});
const data = file.parse(raw);

export const countryDataInfo = { source: data.source, fetchedAt: data.fetchedAt, count: Object.keys(data.countries).length };

export function getCountry(cca2: string): CountryRecord | undefined {
  return data.countries[cca2.trim().toUpperCase()];
}

/** Codes + English names, sorted, for the free-text country select. */
export function listCountries(): { code: string; nameEn: string }[] {
  return Object.entries(data.countries)
    .map(([code, c]) => ({ code, nameEn: c.nameEn }))
    .sort((a, b) => a.nameEn.localeCompare(b.nameEn));
}
