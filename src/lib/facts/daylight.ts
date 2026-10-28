import { getPosition, getTimes } from "suncalc";
import type { DaylightDay } from "@/lib/domain/facts";

const valid = (d: Date | null | undefined): d is Date => !!d && Number.isFinite(d.getTime());

/**
 * Sun times for each date at a place. Times are UTC ISO instants (the UI formats them in the
 * destination's IANA zone). `dusk` = civil dusk ("dark from"). Polar day/night: times null.
 */
export function daylightFor(lat: number, lon: number, dates: string[]): DaylightDay[] {
  return dates.map((date) => {
    const [y, m, d] = date.split("-").map(Number);
    // Local solar noon, so the right calendar day is picked even far from Greenwich.
    const probe = new Date(Date.UTC(y, m - 1, d, 12) - (lon / 15) * 3_600_000);
    const t = getTimes(probe, lat, lon);
    const { sunrise, sunset, dusk, solarNoon } = t;
    if (!valid(sunrise) || !valid(sunset)) {
      const up = getPosition(valid(solarNoon) ? solarNoon : probe, lat, lon).altitude > 0;
      return {
        date,
        sunrise: null,
        sunset: null,
        dusk: null,
        daylightMinutes: up ? 1440 : 0,
        polar: up ? "day" : "night",
      };
    }
    const minutes = Math.round((sunset.getTime() - sunrise.getTime()) / 60_000);
    return {
      date,
      sunrise: sunrise.toISOString(),
      sunset: sunset.toISOString(),
      dusk: valid(dusk) ? dusk.toISOString() : null,
      daylightMinutes: minutes,
    };
  });
}
