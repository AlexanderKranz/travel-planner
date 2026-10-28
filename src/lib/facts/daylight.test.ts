import { describe, expect, it } from "vitest";
import { daylightFor } from "./daylight";

const localTime = (iso: string | null, tz: string) =>
  new Intl.DateTimeFormat("de-DE", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso ?? ""));

describe("daylightFor", () => {
  it("Passau 2026-12-15: sunrise ~07:50, sunset ~16:10, civil dusk ~16:45 local", () => {
    const [d] = daylightFor(48.5665, 13.43122, ["2026-12-15"]);
    expect(localTime(d.sunrise, "Europe/Berlin")).toMatch(/^07:[45]\d$/);
    expect(localTime(d.sunset, "Europe/Berlin")).toMatch(/^16:[01]\d$/);
    const dusk = localTime(d.dusk, "Europe/Berlin");
    expect(dusk >= "16:35" && dusk <= "16:55").toBe(true);
    expect(d.daylightMinutes).toBeGreaterThan(480);
    expect(d.daylightMinutes).toBeLessThan(500);
    expect(d.polar).toBeUndefined();
  });

  it("polar day at Tromso in June, polar night in December", () => {
    const [june] = daylightFor(69.65, 18.96, ["2026-06-21"]);
    expect(june).toMatchObject({ sunrise: null, sunset: null, polar: "day", daylightMinutes: 1440 });
    const [dec] = daylightFor(69.65, 18.96, ["2026-12-21"]);
    expect(dec).toMatchObject({ sunrise: null, sunset: null, polar: "night", daylightMinutes: 0 });
  });

  it("returns instants in UTC and handles the DST change day (Berlin 2026-03-29)", () => {
    const [d] = daylightFor(52.52, 13.405, ["2026-03-29"]);
    expect(d.sunrise?.endsWith("Z")).toBe(true);
    // After the change CEST (UTC+2): sunrise ~06:48 local (05:48 before the change).
    expect(localTime(d.sunrise, "Europe/Berlin")).toMatch(/^06:4\d$/);
  });

  it("picks the right calendar day far east (Tokyo)", () => {
    const [d] = daylightFor(35.68, 139.69, ["2026-12-15"]);
    expect(localTime(d.sunrise, "Asia/Tokyo")).toMatch(/^06:4\d$/);
  });
});
