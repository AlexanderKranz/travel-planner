import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRIVE_HOURS,
  DRIVE_LIMIT_OPTIONS,
  DRIVE_TOLERANCE_MIN,
  driveCutoffKm,
  driveHintRadiusKm,
  driveMaxMin,
  homeCell,
  roundedDriveMin,
} from "./estimate";

describe("drive radius hint and cutoff (spec section 4)", () => {
  it.each([
    [2, 180, 240],
    [4, 360, 480],
    [8, 720, 960],
    [12, 1080, 1440],
  ])("%s h -> hint %s km, cutoff %s km", (h, hint, cutoff) => {
    expect(driveHintRadiusKm(h)).toBe(hint);
    expect(driveCutoffKm(h)).toBe(cutoff);
  });
  it("half hours round to whole km", () => {
    expect(driveHintRadiusKm(1.5)).toBe(135);
    expect(driveCutoffKm(2.5)).toBe(300);
  });
});

describe("limit + tolerance", () => {
  it("a place passes up to 60 * limit + 10 min", () => {
    expect(DRIVE_TOLERANCE_MIN).toBe(10);
    expect(driveMaxMin(4)).toBe(250);
    expect(driveMaxMin(1)).toBe(70);
    expect(driveMaxMin(12)).toBe(730);
  });
});

describe("card rounding", () => {
  it("nearest half hour, at least 30 minutes", () => {
    expect(roundedDriveMin(3)).toBe(30);
    expect(roundedDriveMin(44)).toBe(30);
    expect(roundedDriveMin(46)).toBe(60);
    expect(roundedDriveMin(210)).toBe(210);
  });
  it("a card never shows more than the limit: limit + 10 min rounds down to the limit, for every choice", () => {
    for (const h of DRIVE_LIMIT_OPTIONS) expect(roundedDriveMin(driveMaxMin(h))).toBe(h * 60);
  });
});

describe("limit choices", () => {
  it("1 to 12 h, default 4 h in the list, no 'no limit' value", () => {
    expect(DRIVE_LIMIT_OPTIONS[0]).toBe(1);
    expect(DRIVE_LIMIT_OPTIONS.at(-1)).toBe(12);
    expect(DRIVE_LIMIT_OPTIONS).toContain(DEFAULT_DRIVE_HOURS);
    expect(DRIVE_LIMIT_OPTIONS.every((h) => (h * 2) % 1 === 0)).toBe(true); // the API accepts half hours only
  });
});

describe("homeCell", () => {
  it("is the start at two decimals, so two towns of one name differ", () => {
    expect(homeCell({ lat: 50.1109, lon: 8.6821 })).toBe("50.11,8.68");
    expect(homeCell({ lat: 49.35, lon: 8.14 })).not.toBe(homeCell({ lat: 54.1, lon: 10.8 }));
  });
});
