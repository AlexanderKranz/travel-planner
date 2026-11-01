import "server-only";
import type { Plan } from "@/lib/domain/plan";
import { daylightFor } from "@/lib/facts/daylight";
import { climateGlance, middleDay } from "@/lib/facts/glance";
import type { PlanGlance } from "@/lib/facts/plan-glance";
import { planReferenceDates } from "@/lib/facts/plan-time-difference";
import { isValidTimeZone, utcOffsets } from "@/lib/facts/time-difference";
import { getCountry } from "@/lib/integrations/countries";
import { localHhmm } from "@/lib/plan/input";

/** The trip's current destination. */
export type PlanGlancePlace = { name: string; countryCode: string | null; lat: number | null; lon: number | null; timezone: string | null };

function glanceDaylight(plan: Pick<Plan, "facts">, place: PlanGlancePlace | null): PlanGlance["daylight"] {
  const facts = plan.facts.daylight;
  const day = facts ? middleDay(facts.days) : null;
  if (!facts || !day) return null;
  const live = place?.lat != null && place.lon != null ? daylightFor(place.lat, place.lon, [day.date])[0] : null;
  if (live?.polar) return { date: day.date, sunrise: null, sunset: null, dusk: null, polar: live.polar };
  if (!day.sunrise) return null;
  return {
    date: day.date,
    sunrise: day.sunrise,
    sunset: (live && localHhmm(live.sunset, facts.timezone)) ?? null,
    dusk: day.dusk,
  };
}

function glanceCountry(plan: Pick<Plan, "header" | "facts">, code: string | null, today: string): PlanGlance["country"] {
  const c = code ? getCountry(code) : undefined;
  if (!code || !c) return null;
  const iana = plan.facts.daylight?.timezone;
  const refs = planReferenceDates(plan.header, today);
  const offset = iana && isValidTimeZone(iana) ? utcOffsets(iana, refs.length ? refs : [today])[0] : undefined;
  return {
    code: code.toUpperCase(),
    nameEn: c.nameEn,
    currencies: c.currencies.slice(0, 2),
    callingCode: c.callingCodes[0] ?? null,
    drivingSide: c.drivingSide,
    timezone: [iana, offset ? `UTC${offset}` : null].filter(Boolean).join(" · ") || null,
  };
}

/** Pure. `place` only counts while it is still the plan's destination: after a change it would describe another place. */
export function planGlance(plan: Pick<Plan, "header" | "facts">, place: PlanGlancePlace | null, today: string): PlanGlance {
  // The plan stores no place id: name plus zone tells a changed destination apart, also one of the same name.
  const zone = plan.facts.daylight?.timezone ?? null;
  const current = place && place.name.slice(0, 120) === plan.header.destination && (place.timezone ?? null) === zone ? place : null;
  const months = [...(plan.facts.climate?.months ?? [])].sort((a, b) => a.month - b.month);
  const climate = climateGlance(months);
  return {
    climate: climate && { ...climate, months: months.map((m) => m.month) },
    daylight: glanceDaylight(plan, current),
    country: glanceCountry(plan, current?.countryCode ?? null, today),
  };
}
