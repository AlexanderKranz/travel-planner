/** Open-Meteo forecasts reach 16 days ahead (spec 17.1 [P8]). Pure, safe for client components. */
export const FORECAST_DAYS = 16;

/**
 * Today and the next 15 days, compared as UTC ISO dates with one day of slack on both ends (a tour centre may be up
 * to 14 h ahead of or behind UTC). A date Open-Meteo cannot serve then fails the fetch and shows nothing.
 */
export function inForecastRange(date: string, now: Date = new Date()): boolean {
  const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  return date >= day(-1) && date <= day(FORECAST_DAYS);
}
