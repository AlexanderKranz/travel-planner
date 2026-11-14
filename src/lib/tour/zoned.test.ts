import { describe, expect, it } from "vitest";
import { isoWithOffset, knownTimeZone, localHhmm, zonedInstant, zoneOffsetMin } from "./zoned";

describe("zoned times", () => {
  it("Wien in winter and summer", () => {
    expect(zonedInstant("2026-11-17", "10:00", "Europe/Vienna")).toEqual({ utcMs: Date.UTC(2026, 10, 17, 9, 0), iso: "2026-11-17T10:00:00+01:00" });
    expect(zonedInstant("2026-07-01", "10:00", "Europe/Vienna").iso).toBe("2026-07-01T10:00:00+02:00");
    expect(zoneOffsetMin("Europe/Vienna", Date.UTC(2026, 6, 1, 8))).toBe(120);
  });

  it("across the spring DST switch and west of UTC", () => {
    // 2026-03-29 03:00 Wien is already summer time.
    expect(zonedInstant("2026-03-29", "03:30", "Europe/Vienna").iso).toBe("2026-03-29T03:30:00+02:00");
    expect(zonedInstant("2026-11-17", "08:15", "America/New_York").iso).toBe("2026-11-17T08:15:00-05:00");
  });

  it("formats an instant as local ISO with the offset", () => {
    expect(isoWithOffset(Date.UTC(2026, 10, 17, 9, 42), "Europe/Vienna")).toBe("2026-11-17T10:42:00+01:00");
    expect(isoWithOffset(Date.UTC(2026, 6, 1, 23, 30), "Europe/Vienna")).toBe("2026-07-02T01:30:00+02:00");
  });

  it("formats UTC instants as local HH:MM and checks zones", () => {
    expect(localHhmm(Date.UTC(2026, 10, 17, 9, 2), "Europe/Vienna")).toBe("10:02");
    expect(localHhmm(Date.UTC(2026, 10, 17, 23, 30), "Europe/Vienna")).toBe("00:30");
    expect(knownTimeZone("Europe/Madrid")).toBe(true);
    expect(knownTimeZone("Mars/Base")).toBe(false);
    expect(knownTimeZone(null)).toBe(false);
  });
});
