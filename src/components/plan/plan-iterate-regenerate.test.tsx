import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/lib/server/plans", () => ({ editPlan: vi.fn() }));
vi.mock("./plan-runner", () => ({
  PlanRunner: ({ label, disabled }: { label: string; disabled?: boolean }) => <button disabled={disabled}>{label}</button>,
  PlanErrorBanner: () => null,
}));

import { PlanIterate } from "./plan-iterate";

const render = (regenerate?: { aiEnabled: boolean; predatesSuggestions: boolean }) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <PlanIterate tripId="t1" locale="en" baseVersion={1} dayCount={3} aiBlock={null} editBlock={null} regenerate={regenerate} />
    </NextIntlClientProvider>,
  );

describe("PlanIterate regenerate", () => {
  it("shows no regenerate button without the prop (old version, busy)", () => {
    expect(render()).not.toContain("Regenerate plan");
  });
  it("shows the button and no hint for a current plan", () => {
    const html = render({ aiEnabled: true, predatesSuggestions: false });
    expect(html).toContain("Regenerate plan");
    expect(html).not.toContain("before concrete restaurant");
    expect(html).not.toContain("switched off");
  });
  it("shows the hint for a pre-plan-6 plan", () => {
    expect(render({ aiEnabled: true, predatesSuggestions: true })).toContain("before concrete restaurant");
  });
  it("disables the button and says so when AI is off", () => {
    const html = render({ aiEnabled: false, predatesSuggestions: false });
    expect(html).toContain('<button disabled="">Regenerate plan');
    expect(html).toContain("AI is currently switched off.");
  });
});
