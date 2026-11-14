/**
 * Wall-clock times of a tour city (spec 17.4 "Transit time zone"). Pure, built on Intl with an IANA zone, so DST
 * switches follow the city, never the server or the browser.
 */

/** Minutes the zone is ahead of UTC at that instant (Wien in summer: 120). */
export function zoneOffsetMin(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(utcMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"));
  return Math.round((asUtc - Math.floor(utcMs / 60000) * 60000) / 60000);
}

/** The UTC instant of `date` `hhmm` local time in `timeZone`, plus the ISO string with that offset for requests. */
export function zonedInstant(date: string, hhmm: string, timeZone: string): { utcMs: number; iso: string } {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes: the offset at the guessed instant, then at the corrected one (correct across DST switches).
  let off = zoneOffsetMin(timeZone, wall);
  off = zoneOffsetMin(timeZone, wall - off * 60000);
  const utcMs = wall - off * 60000;
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const pad = (v: number) => String(v).padStart(2, "0");
  return { utcMs, iso: `${date}T${hhmm}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}` };
}

/** Local HH:MM in `timeZone` of a UTC instant. */
export function localHhmm(utcMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(utcMs));
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function knownTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
