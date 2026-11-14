import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveSteps, doneCount, ONBOARDING_HINTS, ONBOARDING_STEPS, shouldShowOnboarding } from "./onboarding";

const empty = { homeAirports: [], birthdate: null, homeLocation: null, groupCount: 0, purposeCount: 0, tripCount: 0 };

describe("deriveSteps", () => {
  it("is all open for a new user", () => {
    const s = deriveSteps(empty);
    expect(s).toEqual({ about: false, group: false, purpose: false, trip: false });
    expect(doneCount(s)).toBe(0);
  });
  it("counts about as done with an airport, a birthdate or a home place", () => {
    expect(deriveSteps({ ...empty, homeAirports: ["FRA"] }).about).toBe(true);
    expect(deriveSteps({ ...empty, birthdate: "1980-05-01" }).about).toBe(true);
    expect(deriveSteps({ ...empty, homeLocation: "Wien" }).about).toBe(true);
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

describe("ONBOARDING_HINTS (#206)", () => {
  const more = (loc: string) => JSON.parse(readFileSync(join(__dirname, `../../messages/${loc}.json`), "utf8")).start.more;

  it("every hint has a title and text in de and en, and link text exactly when it links", () => {
    for (const loc of ["de", "en"]) {
      const m = more(loc);
      expect(String(m.title).trim().length).toBeGreaterThan(0);
      expect(String(m.lead).trim().length).toBeGreaterThan(0);
      for (const h of ONBOARDING_HINTS) {
        const keys = h.href === null ? ["title", "text"] : ["title", "text", "link"];
        expect(Object.keys(m[h.key]).sort(), `${loc}: ${h.key}`).toEqual([...keys].sort());
        for (const k of keys) expect(String(m[h.key][k]).trim().length, `${loc}: ${h.key}.${k}`).toBeGreaterThan(0);
      }
    }
  });

  it("hints are not steps: the progress still counts the four steps only", () => {
    expect(ONBOARDING_STEPS).toHaveLength(4);
    expect(ONBOARDING_HINTS.map((h) => h.key)).toEqual(["stops", "tours", "plan", "sharing"]);
  });
});
