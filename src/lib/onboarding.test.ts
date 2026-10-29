import { describe, expect, it } from "vitest";
import { deriveSteps, doneCount, shouldShowOnboarding } from "./onboarding";

const empty = { homeAirports: [], birthdate: null, groupCount: 0, purposeCount: 0, tripCount: 0 };

describe("deriveSteps", () => {
  it("is all open for a new user", () => {
    const s = deriveSteps(empty);
    expect(s).toEqual({ about: false, group: false, purpose: false, trip: false });
    expect(doneCount(s)).toBe(0);
  });
  it("counts about as done with an airport or a birthdate", () => {
    expect(deriveSteps({ ...empty, homeAirports: ["FRA"] }).about).toBe(true);
    expect(deriveSteps({ ...empty, birthdate: "1980-05-01" }).about).toBe(true);
  });
  it("derives each step from its own data", () => {
    const s = deriveSteps({ ...empty, groupCount: 1, tripCount: 2 });
    expect(s).toEqual({ about: false, group: true, purpose: false, trip: true });
    expect(doneCount(s)).toBe(2);
  });
});

describe("shouldShowOnboarding", () => {
  it("redirects a new user once", () => {
    expect(shouldShowOnboarding({ isDemo: false, onboardingDoneAt: null })).toBe(true);
  });
  it("does not redirect after finishing or skipping", () => {
    expect(shouldShowOnboarding({ isDemo: false, onboardingDoneAt: "2026-11-03T10:00:00Z" })).toBe(false);
  });
  it("never redirects the demo account", () => {
    expect(shouldShowOnboarding({ isDemo: true, onboardingDoneAt: null })).toBe(false);
  });
});
