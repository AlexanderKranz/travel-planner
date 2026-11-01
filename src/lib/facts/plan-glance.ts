import type { Plan } from "@/lib/domain/plan";
import type { CountryFacts } from "@/lib/domain/facts";
import { currencyLabel, flagEmoji, monthsLabel, regionName, type ClimateGlance } from "./glance";
import type { PlanTimeDifference } from "./plan-time-difference";

/**
 * The "At a glance" tiles for share page and PDF. Display values only: the coordinates stay on the server.
 * No external calls (ADR 0005): climate and sunrise come from the plan snapshot, country from the local dataset,
 * sunset from suncalc.
 */
export type PlanGlance = {
  climate: (ClimateGlance & { months: number[] }) | null;
  daylight: { date: string; sunrise: string | null; sunset: string | null; dusk: string | null; polar?: "day" | "night" } | null;
  country: {
    code: string;
    nameEn: string;
    currencies: CountryFacts["currencies"];
    callingCode: string | null;
    drivingSide: CountryFacts["drivingSide"];
    timezone: string | null;
  } | null;
};

export type GlanceChip = { key: "currency" | "callingCode" | "driving" | "timezone"; id: string; text: string };
export type GlanceTile = {
  key: "climate" | "daylight" | "country" | "time";
  label: string;
  value: string;
  flag?: string;
  lines: string[];
  chips: GlanceChip[];
};

type Translate = (key: string, vars?: Record<string, string>) => string;

/** One rendering of the tiles for web and PDF. `t` resolves the `pdf.glance` keys. */
export function planGlanceTiles(
  doc: { glance?: PlanGlance; timeDifference?: PlanTimeDifference | null },
  locale: string,
  t: Translate,
): GlanceTile[] {
  const { climate, daylight, country } = doc.glance ?? { climate: null, daylight: null, country: null };
  const td = doc.timeDifference ?? null;
  const one = (n: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(n);
  const deg = (n: number) => `${new Intl.NumberFormat(locale).format(Math.round(n))}°`;
  const tiles: GlanceTile[] = [];
  if (climate) {
    tiles.push({
      key: "climate",
      label: t("climateFor", { months: monthsLabel(climate.months, locale) }),
      value: `${deg(climate.tMaxC)} / ${deg(climate.tMinC)}`,
      lines: [t("wetDays", { days: one(climate.wetDays) }), t("sun", { h: one(climate.sunshineHours) })],
      chips: [],
    });
  }
  if (daylight) {
    const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${daylight.date}T12:00:00Z`));
    tiles.push({
      key: "daylight",
      label: t("daylightOn", { date }),
      value: daylight.polar
        ? t(daylight.polar === "day" ? "polarDay" : "polarNight")
        : [daylight.sunrise, daylight.sunset].filter(Boolean).join("–"),
      lines: daylight.dusk ? [t("dusk", { time: daylight.dusk })] : [],
      chips: [],
    });
  }
  if (country) {
    const chips: GlanceChip[] = [
      ...country.currencies.map((c) => ({ key: "currency" as const, id: c.code, text: currencyLabel(c) })),
      ...(country.callingCode ? [{ key: "callingCode" as const, id: "callingCode", text: country.callingCode }] : []),
      { key: "driving", id: "driving", text: t(country.drivingSide) },
      ...(country.timezone ? [{ key: "timezone" as const, id: "timezone", text: country.timezone }] : []),
    ];
    tiles.push({
      key: "country",
      label: t("country"),
      value: regionName(country.code, locale, country.nameEn),
      flag: flagEmoji(country.code),
      lines: [],
      chips,
    });
  }
  if (td) {
    const sign = td.kind === "behind" ? "−" : "+";
    tiles.push({
      key: "time",
      label: t("timeTitle"),
      value: td.kind === "range" ? t("timeRange", { from: td.hours, to: td.to ?? td.hours }) : t("timeHours", { diff: `${sign}${td.hours}` }),
      lines: [
        t("timeVs", { home: td.home ?? t("timeDefaultHome") }),
        ...td.notes.map((n) => t(n === "current" ? "timeCurrent" : n === "changes" ? "timeChanges" : "timeByMonth")),
      ],
      chips: [],
    });
  }
  return tiles;
}

/** Check date of the tiles: when the climate was fetched (the other values are computed). */
export const planGlanceChecked = (plan: Pick<Plan, "facts">): string | null => plan.facts.climate?.fetchedAt ?? null;
