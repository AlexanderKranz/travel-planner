import type { EntryTraits } from "@/lib/domain/group";
import type { OsmKey, PlanFactsDigest, PlanHeader, PlanPlace } from "@/lib/domain/plan";
import type { Locale } from "@/lib/domain/profile";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import type { TravelGroup } from "@/lib/domain/group";
import type { TripFacts } from "@/lib/domain/facts";
import { notImplemented } from "./not-implemented";

/** What Sonnet sees (spec 3.1). Canonical JSON, compact keys, no timestamps or other volatile values. */
export type PlanInput = {
  v: 1;
  lang: "de" | "en";
  trip: {
    dest: string;
    place?: string;
    country?: string;
    kind: "city" | "region" | "freetext";
    radiusKm?: number;
    days: number;
    start?: string;
    end?: string;
    months?: number[];
    flights: boolean;
    notes?: string;
  };
  dayList: { n: number; date?: string; dow?: "Mo" | "Tu" | "We" | "Th" | "Fr" | "Sa" | "Su"; sunrise?: string; dusk?: string }[];
  /** Months mode only. */
  daylightByMonth?: { m: number; sunrise: string; dusk: string }[];
  group?: {
    size: number;
    notes?: string;
    entries: { n: number; age?: number; approx?: true; label?: string; traits?: EntryTraits; notes?: string }[];
  };
  purpose?: {
    name: string;
    pace?: string;
    budget?: string;
    rooms?: string;
    accommodation?: string[];
    interests: string[];
    hard: string[];
    soft: string[];
    summary?: string;
  };
  /** Selected months only. */
  climate?: { m: number; tmax: number; tmin: number; wet: number; sun: number }[];
  country?: { name: string; currency: string[]; drivingSide: "left" | "right"; tz?: string };
  /** Gateway airports (spec 3.2). */
  airports?: { iata: string; name: string; km: number }[];
  places: { id: string /* p1.. */; name: string; cat: string; km: number; ap?: number; i: string /* interest */ }[];
  /** Interests with no verified candidates. */
  noSource: string[];
};

/** Stored per version: exact LLM input + place index (`p1` → OSM key and place). */
export type PlanInputStored = { llm: PlanInput; index: Record<string /* p1 */, { key: OsmKey; place: PlanPlace }> };

export type BuildPlanInputArgs = {
  trip: Trip;
  group: TravelGroup | null;
  purpose: TripPurpose | null;
  profileBirthdate: string | null;
  facts: TripFacts;
  locale: Locale;
  today: string;
};

export function buildPlanInput(a: BuildPlanInputArgs): {
  stored: PlanInputStored;
  header: Omit<PlanHeader, "generatedAt" | "model">;
  digest: PlanFactsDigest;
} {
  void a;
  return notImplemented("buildPlanInput");
}
