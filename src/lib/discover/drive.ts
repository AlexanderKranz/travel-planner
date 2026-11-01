import { haversineKm } from "@/lib/facts/places";
import { driveCutoffKm } from "@/lib/drive/estimate";

/**
 * Step 2 of the verification in drive mode (spec find-destinations-drive section 4): straight line from the start
 * to the anchor, no network. It only saves ORS calls on places that are clearly out of reach and must never decide
 * a close case; the ORS drive time is authoritative.
 */
export type DriveAssessment = { pass: true } | { pass: false };

export function assessDrive(anchor: { lat: number; lon: number }, home: { lat: number; lon: number }, maxHours: number): DriveAssessment {
  return haversineKm(home, anchor) > driveCutoffKm(maxHours) ? { pass: false } : { pass: true };
}
