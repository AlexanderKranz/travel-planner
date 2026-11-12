/** Test helpers for city tours in the plan (not imported by app code). */
import { TourInput, type TourResult } from "@/lib/domain/tour";
import { HOFBURG, NASCHMARKT, STEPHANSDOM, WIEN_CITY } from "@/lib/tour/fixtures.test-data";
import { encodePolyline } from "@/lib/tour/polyline";
import type { LinkedTour } from "./tour-blocks";

/** Wien: Stephansdom, Hofburg, Naschmarkt (plan keys way/1, way/2, way/3), on foot. */
export function wienInput(over: Partial<TourInput> = {}): TourInput {
  return TourInput.parse({ city: WIEN_CITY, places: [STEPHANSDOM, HOFBURG, NASCHMARKT], ...over });
}

const leg = (a: { key: string; lat: number; lon: number }, b: { key: string; lat: number; lon: number }, min: number, km: number) => ({
  from: a.key,
  to: b.key,
  mode: "foot" as const,
  route: "fastest" as const,
  min,
  km,
  poly: encodePolyline([
    [a.lat, a.lon],
    [b.lat, b.lon],
  ]),
  s: "ok" as const,
});

/** Result in the order Hofburg → Stephansdom → Naschmarkt: 2 legs, 1.6 km, 130 min with dwell. */
export function wienResult(over: Partial<TourResult> = {}): TourResult {
  return {
    v: 1,
    order: [HOFBURG.key, STEPHANSDOM.key, NASCHMARKT.key],
    legs: [leg(HOFBURG, STEPHANSDOM, 9, 0.7), leg(STEPHANSDOM, NASCHMARKT, 15, 0.9)],
    totalMin: 130,
    fit: "none",
    sights: [],
    source: { ors: "2026-11-12T10:00:00.000Z" },
    ...over,
  };
}

export function linkedTour(over: Partial<LinkedTour> = {}): LinkedTour {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    tripDay: 2,
    title: null,
    input: wienInput({ startTime: "10:00" }),
    result: wienResult(),
    updatedAt: "2026-11-12T10:00:00.000Z",
    ...over,
  };
}

/** A stored `city_tours` row (the share read's columns). */
export function tourRow(over: Partial<{ id: string; trip_id: string; trip_day: number | null; title: string | null; input: unknown; result: unknown; updated_at: string }> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    trip_id: "T1",
    trip_day: 2,
    title: null,
    input: wienInput({ startTime: "10:00" }),
    result: wienResult(),
    updated_at: "2026-11-12T10:00:00.000Z",
    ...over,
  };
}

