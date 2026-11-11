import { describe, expect, it } from "vitest";
import { PLAN_PROMPT_VERSION } from "@/lib/domain/ai";
import { planInputHash } from "./hash";
import { PATCH_ADDENDUM, SYSTEM_RULES } from "./prompt";
import type { PlanInput } from "./input";

describe("prompt plan-8 (port-places section 3)", () => {
  it("is plan-8 and the hash follows the version, a recording's own version still verifies", () => {
    expect(PLAN_PROMPT_VERSION).toBe("plan-8");
    const llm = { v: 1 } as PlanInput;
    expect(planInputHash(llm)).toBe(planInputHash(llm, "plan-8"));
    expect(planInputHash(llm)).not.toBe(planInputHash(llm, "plan-7"));
  });

  it("the INPUT legend names trip.stops and stopPlaces", () => {
    expect(SYSTEM_RULES).toMatch(/stops \(the schedule, one row per stop: day, place, arr and dep local HH:MM, sea = /);
    expect(SYSTEM_RULES).toMatch(/at = dest or the id of its stopPlaces entry/);
    expect(SYSTEM_RULES).toMatch(/stopPlaces = verified places around the stops of trip\.stops/);
  });

  it("rule 5 reads trip.stops first, then the notes; 'Ankunft morgens' is not a time", () => {
    expect(SYSTEM_RULES).toMatch(/Copy every fixed time from trip\.stops \(arr → from, dep → to\), else from trip\.notes/);
    expect(SYSTEM_RULES).toMatch(/trip\.stops win when both give a time for the same place and day/);
    expect(SYSTEM_RULES).toContain('A note such as "Ankunft morgens" is not a time.');
    expect(SYSTEM_RULES).toMatch(/never gets a time that is not in trip\.stops or trip\.notes/);
  });

  it("rule 3 says stops without their own lists, not stops far from the destination", () => {
    expect(SYSTEM_RULES).toMatch(/stops without their own lists in stopPlaces/);
    expect(SYSTEM_RULES).not.toMatch(/stops far from the destination/);
  });

  it("rule 17 ties activities and meals at a stop to that stop's ids and states the status wording", () => {
    const r17 = SYSTEM_RULES.slice(SYSTEM_RULES.indexOf("\n17. "));
    expect(r17).toMatch(/uses? only that entry's ids \(rules 3 and 16 apply as for the destination\)/);
    expect(r17).toMatch(/Never use a stop's ids on other days/);
    expect(r17).toMatch(/On rows with sea set no ref/);
    expect(r17).toMatch(/s not_found = the place was not found; s error, skipped or cap = its places could not be checked/);
    expect(r17).toContain("Orte in X konnten nicht geprüft werden");
    expect(r17).toMatch(/Activity wishes were only looked up at the destination: at a stop they were not checked, never "not found"/);
  });

  it("the patch addendum lets near be a stop id", () => {
    expect(PATCH_ADDENDUM).toMatch(/restaurants\.near and cafes\.near may be a stopPlaces id \(s1\.\.\) to load more around that stop/);
  });

  it("grows by about what the spec estimates (+270 tokens; measured +340)", () => {
    // plan-7 system rules were 9332 characters (recorded: 3130 tokens including the tool schema). At ~4 characters per
    // token the spec's +270 tokens is about +1080 characters; the legend, rule 5, rule 17 and rule 3 made it +1352.
    const PLAN_7_CHARS = 9332;
    const added = SYSTEM_RULES.length - PLAN_7_CHARS;
    expect(added).toBeGreaterThan(800);
    expect(added).toBeLessThan(1700);
  });
});
