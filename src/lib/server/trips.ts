"use server";

import { fail, type ActionResult } from "@/lib/domain/result";
import type { Trip, TripInput, TripSummary } from "@/lib/domain/trip";

// TODO(phase-2): STUBS. Real implementation: Zod parse, geoId resolution via getPlaceById,
// isKnownIata check, 100-trip cap, 23503 -> not_found, logEvent trip.*, after(warmTripFacts).

export async function listTrips(): Promise<ActionResult<TripSummary[]>> {
  return fail("failed");
}

export async function getTrip(id: string): Promise<ActionResult<Trip>> {
  void id;
  return fail("failed");
}

export async function createTrip(input: TripInput): Promise<ActionResult<Trip>> {
  void input;
  return fail("failed");
}

export async function updateTrip(id: string, input: TripInput): Promise<ActionResult<Trip>> {
  void id;
  void input;
  return fail("failed");
}

export async function deleteTrip(id: string): Promise<ActionResult> {
  void id;
  return fail("failed");
}
