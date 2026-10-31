import "server-only";
import type { CountryFacts, Fact, FactsCtx } from "@/lib/domain/facts";
import type { Trip } from "@/lib/domain/trip";
import { utcOffsets } from "@/lib/facts/time-difference";
import { referenceDates } from "@/lib/facts/trip-timing";
import { countryDataInfo, getCountry } from "@/lib/integrations/countries";
import { unavailable } from "./common";

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
