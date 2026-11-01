"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Profile, ProfileUpdate } from "@/lib/domain/profile";
import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
// Owned by the integrations agent: validates a code against the airport dataset.
import { isKnownIata } from "@/lib/integrations/airports";
import { getPlaceById } from "@/lib/integrations/open-meteo-geocoding";
import { getUserSession } from "./session";

const COLUMNS = "id, role, display_name, locale, home_airports, birthdate, is_demo, onboarding_done_at, home_location, home_timezone, home_geo_id, home_lat, home_lon";

type ProfileRow = {
  id: string;
  role: string;
  display_name: string | null;
  locale: string;
  home_airports: string[];
  birthdate: string | null;
  is_demo: boolean;
  onboarding_done_at: string | null;
  home_location: string | null;
  home_timezone: string | null;
  home_geo_id: number | null;
  home_lat: number | null;
  home_lon: number | null;
};

function rowToProfile(row: ProfileRow) {
  return Profile.safeParse({
    id: row.id,
    role: row.role,
    displayName: row.display_name,
    locale: row.locale,
    homeAirports: row.home_airports,
    birthdate: row.birthdate,
    isDemo: row.is_demo,
    onboardingDoneAt: row.onboarding_done_at,
    homeLocation: row.home_location,
    homeTimezone: row.home_timezone,
    homeGeoId: row.home_geo_id ?? null,
    homeLat: row.home_lat ?? null,
    homeLon: row.home_lon ?? null,
  });
}

export async function getProfile(): Promise<ActionResult<Profile>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const { data, error } = await session.supabase
    .from("profiles")
    .select(COLUMNS)
    .eq("id", session.userId)
    .maybeSingle();
  if (error) return fail("failed");
  if (!data) return fail("not_found");
  const profile = rowToProfile(data);
  return profile.success ? { ok: true, data: profile.data } : fail("failed");
}

type HomeCoords = { home_geo_id: number | null; home_lat: number | null; home_lon: number | null };
const NO_COORDS: HomeCoords = { home_geo_id: null, home_lat: null, home_lon: null };

/**
 * The coordinate columns that go with a home change, resolved here from the place id so the browser never supplies
 * them. No home or no id (a name typed or saved before drive searches existed) clears them. A failed lookup keeps the
 * stored coordinates when the id is unchanged, else clears them: the home itself is still saved (time difference).
 * Returns null = leave the columns alone.
 */
async function homeCoordinates(
  supabase: SupabaseClient,
  userId: string,
  homeLocation: string | null,
  geoId: number | null,
): Promise<HomeCoords | null> {
  if (homeLocation === null || geoId === null) return NO_COORDS;
  try {
    const place = await getPlaceById(geoId, "en");
    if (place) return { home_geo_id: place.geoId, home_lat: place.lat, home_lon: place.lon };
  } catch {
    // fall through: keep or clear below
  }
  const { data } = await supabase.from("profiles").select("home_geo_id").eq("id", userId).maybeSingle();
  return (data as { home_geo_id: number | null } | null)?.home_geo_id === geoId ? null : NO_COORDS;
}

/** Partial update of display name, locale, home airports (max 5, ordered), birthdate and home location + time zone (null clears). */
export async function updateProfile(input: ProfileUpdate): Promise<ActionResult<Profile>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");

  const parsed = ProfileUpdate.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const update = parsed.data;

  if (update.homeAirports?.some((code) => !isKnownIata(code))) return fail("unknown_airport");

  const patch: Record<string, unknown> = {};
  if (update.displayName !== undefined) patch.display_name = update.displayName;
  if (update.locale !== undefined) patch.locale = update.locale;
  if (update.homeAirports !== undefined) patch.home_airports = update.homeAirports;
  if (update.birthdate !== undefined) patch.birthdate = update.birthdate;
  if (update.homeLocation !== undefined) patch.home_location = update.homeLocation;
  if (update.homeTimezone !== undefined) patch.home_timezone = update.homeTimezone;
  if (update.homeLocation !== undefined) {
    const coords = await homeCoordinates(session.supabase as SupabaseClient, session.userId, update.homeLocation, update.homeGeoId ?? null);
    if (coords) Object.assign(patch, coords);
  }
  if (Object.keys(patch).length === 0) return getProfile();

  const { data, error } = await session.supabase
    .from("profiles")
    .update(patch)
    .eq("id", session.userId)
    .select(COLUMNS)
    .maybeSingle();
  if (error) return fail("failed");
  if (!data) return fail("not_found");
  const profile = rowToProfile(data);
  return profile.success ? { ok: true, data: profile.data } : fail("failed");
}

/** Marks the getting-started guide as finished or skipped. Idempotent: the first timestamp is kept. */
export async function markOnboardingDone(): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const { error } = await session.supabase
    .from("profiles")
    .update({ onboarding_done_at: new Date().toISOString() })
    .eq("id", session.userId)
    .is("onboarding_done_at", null);
  if (error) return fail("failed");
  return { ok: true };
}
