import { roundedHalfHourMin } from "@/lib/flights/estimate";

/**
 * Drive-time numbers of the destination search (spec find-destinations-drive section 4). Three levels, cheapest
 * first: the radius hint for the model, a generous straight-line cutoff in code, and the ORS drive time, which is
 * authoritative. Both speeds are starting values for European roads; the live check of 2026-11-01 (Frankfurt to
 * Munich 87, to Marseille 87, Hamburg to Berlin 94 km/h straight-line) fits them.
 */

export const DRIVE_HINT_KM_PER_H = 90; // straight-line progress of a typical long drive
export const DRIVE_CUTOFF_KM_PER_H = 120; // beyond this no real drive gets there
export const DRIVE_TOLERANCE_MIN = 10; // same idea as LIMIT_TOLERANCE_MIN for flights
export const MIN_DRIVE_HOURS = 1;
export const MAX_DRIVE_HOURS = 12;
export const DEFAULT_DRIVE_HOURS = 4;
/** Choices of the drive limit, in hours; no "no limit" entry (a limit is the only meaning of the mode). */
export const DRIVE_LIMIT_OPTIONS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8, 10, 12] as const;

export const driveHintRadiusKm = (hours: number): number => Math.round(hours * DRIVE_HINT_KM_PER_H);
export const driveCutoffKm = (hours: number): number => Math.round(hours * DRIVE_CUTOFF_KM_PER_H);

/** Most minutes a verified drive may take for a limit in hours: the limit plus the tolerance. */
export const driveMaxMin = (hours: number): number => 60 * hours + DRIVE_TOLERANCE_MIN;

/** Nearest half hour for the card ("ca. 3.5 h"), at least 30 minutes; the limit + tolerance rounds down to the limit. */
export const roundedDriveMin = (min: number): number => Math.max(30, roundedHalfHourMin(min));

/** "50.11,8.68": the start place at ~1 km, for the cache hash only (two towns named Neustadt differ). */
export const homeCell = (p: { lat: number; lon: number }): string => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
