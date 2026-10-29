/** Getting-started guide: pure step derivation and redirect rule (no I/O). */

export type OnboardingFacts = {
  homeAirports: readonly string[];
  birthdate: string | null;
  groupCount: number;
  purposeCount: number;
  tripCount: number;
};

export const ONBOARDING_STEPS = ["about", "group", "purpose", "trip"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Step completion is derived from the user's data, never stored. */
export function deriveSteps(f: OnboardingFacts): Record<OnboardingStep, boolean> {
  return {
    about: f.homeAirports.length > 0 || f.birthdate !== null,
    group: f.groupCount > 0,
    purpose: f.purposeCount > 0,
    trip: f.tripCount > 0,
  };
}

export function doneCount(steps: Record<OnboardingStep, boolean>): number {
  return ONBOARDING_STEPS.filter((s) => steps[s]).length;
}

/**
 * Whether /app should send the user to the guide: only before it was finished or skipped, and never for the shared
 * demo account (its data is reset, so a redirect there would repeat for every visitor).
 */
export function shouldShowOnboarding(p: { isDemo: boolean; onboardingDoneAt: string | null }): boolean {
  return !p.isDemo && p.onboardingDoneAt === null;
}
