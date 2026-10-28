import "server-only";
import type { CountryFacts, Fact, FactsCtx } from "@/lib/domain/facts";
import type { Trip } from "@/lib/domain/trip";
import { referenceDates } from "@/lib/facts/trip-timing";
import { countryDataInfo, getCountry } from "@/lib/integrations/countries";
import { unavailable } from "./common";

/** UTC offsets ("+01:00") of an IANA zone on the given dates, via Intl (handles DST). */
export function utcOffsets(iana: string, dates: string[]): string[] {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: iana, timeZoneName: "longOffset" });
  const out = new Set<string>();
  for (const d of dates) {
    const part = fmt.formatToParts(new Date(`${d}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = /GMT([+-]\d{2}:\d{2})?/.exec(part);
    if (m) out.add(m[1] ?? "+00:00");
  }
  return [...out].sort();
}

export async function getCountryFacts(trip: Trip, ctx: FactsCtx): Promise<Fact<CountryFacts>> {
  try {
    const code = trip.destination.countryCode;
    if (!code) return unavailable("no_country");
    const c = getCountry(code);
    if (!c) return unavailable("not_found", "rest_countries");
    const iana = trip.destination.kind === "freetext" ? null : trip.destination.timezone;
    const refs = referenceDates(trip, ctx.today);
    return {
      status: "ok",
      data: {
        code: code.toUpperCase(),
        nameEn: c.nameEn,
        capital: c.capital,
        currencies: c.currencies,
        languages: c.languages,
        callingCodes: c.callingCodes,
        drivingSide: c.drivingSide,
        // The dataset has no per-country zone list (see src/data/README.md): countryZones stays empty.
        timezone: { iana, utcOffsets: iana ? utcOffsets(iana, refs.length ? refs : [ctx.today]) : [], countryZones: [] },
        plugs: null,
      },
      source: "rest_countries",
      fetchedAt: `${countryDataInfo.fetchedAt}T00:00:00.000Z`,
      stale: false,
    };
  } catch {
    return unavailable("provider_error", "rest_countries");
  }
}
