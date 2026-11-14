/**
 * WMO weather interpretation codes (Open-Meteo `weather_code`) grouped for one short label each
 * (`tours.forecast.codes.*`). Pure; null for an unknown code.
 */
export const WMO_GROUPS = [
  "clear",
  "mainlyClear",
  "partlyCloudy",
  "overcast",
  "fog",
  "drizzle",
  "rain",
  "freezingRain",
  "snow",
  "showers",
  "snowShowers",
  "thunder",
] as const;
export type WmoGroup = (typeof WMO_GROUPS)[number];

export function wmoGroup(code: number | null): WmoGroup | null {
  if (code === null) return null;
  if (code === 0) return "clear";
  if (code === 1) return "mainlyClear";
  if (code === 2) return "partlyCloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 55) return "drizzle";
  if (code === 56 || code === 57 || code === 66 || code === 67) return "freezingRain";
  if (code >= 61 && code <= 65) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "showers";
  if (code === 85 || code === 86) return "snowShowers";
  if (code >= 95 && code <= 99) return "thunder";
  return null;
}
