/**
 * Trip purpose text (spec trip-purpose-text, tests section; CI, no network): the golf fixture's purpose text as the
 * trip's one-off purpose, with the recorded tags, gives the same places and the same PlanInput as the saved purpose
 * apart from `purpose.name` (and the header's `purposeName`). Without tags the raw text is the fallback.
 */
import { describe, expect, it, vi } from "vitest";
import type { PurposeTags } from "@/lib/domain/plan";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import { oneOffLabel } from "@/lib/discover/one-off";
import { ownAgeRefs } from "@/lib/group";
import { buildPlanInput } from "@/lib/plan/input";
import { tripPurpose } from "@/lib/purpose-source";
import { EVAL_PROFILE_BIRTHDATE, EVAL_TODAY, evalDrive, evalPurpose, evalFacts, evalGroup, evalItems, evalTrip, FIXTURES } from "./build-input";
import { readRecording } from "./recorded";

vi.mock("server-only", () => ({}));

const tags = readRecording<PurposeTags>("golf", "tags")?.output ?? null;
const text = FIXTURES.golf.purpose!.text!;

function inputFor(trip: Trip, purpose: TripPurpose | null) {
  const facts = evalFacts("golf", trip, purpose);
  const built = buildPlanInput({
    trip,
    group: evalGroup("golf"),
    purpose,
    ageRefs: ownAgeRefs(EVAL_PROFILE_BIRTHDATE),
    facts,
    locale: FIXTURES.golf.locale,
    today: EVAL_TODAY,
    items: evalItems("golf"),
    drive: evalDrive("golf"),
  });
  return { facts, ...built };
}

/** The trip with its purpose text as the one-off purpose. */
function oneOffInput(withTags: PurposeTags | null) {
  const trip = { ...evalTrip("golf"), purposeId: null, purposeText: text, purposeTags: withTags ?? undefined };
  return inputFor(trip, tripPurpose(trip, null));
}

/** The saved purpose with the same text and no constraints (a one-off has none; the fixture's constraints also set the flight limit). */
function savedInput(withTags: PurposeTags | null) {
  return inputFor(evalTrip("golf"), { ...evalPurpose("golf", withTags)!, constraints: [] });
}

describe("one-off trip purpose equals the saved purpose (recorded tags)", () => {
  it("has recorded tags to work with", () => {
    expect(tags).not.toBeNull();
  });

  it("the same places and the same PlanInput apart from purpose.name", () => {
    const saved = savedInput(tags);
    const typed = oneOffInput(tags);
    expect(typed.facts.places).toEqual(saved.facts.places);
    expect(typed.stored.llm.places).toEqual(saved.stored.llm.places);
    const { purpose: sp, ...savedRest } = saved.stored.llm;
    const { purpose: tp, ...typedRest } = typed.stored.llm;
    expect(typedRest).toEqual(savedRest);
    expect(tp).toEqual({ ...sp, name: oneOffLabel(text) });
    expect(typed.header.purposeName).toBe(oneOffLabel(text));
  });

  it("without tags the raw text (cut) is the summary and the places come from the default interests", () => {
    const typed = oneOffInput(null);
    expect(typed.stored.llm.purpose).toMatchObject({ name: oneOffLabel(text), summary: text.slice(0, 600), hard: [] });
  });
});
