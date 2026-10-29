import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./lib/fixtures";

/** Fails on serious and critical WCAG A/AA violations; the message lists rule, impact and targets. */
async function expectNoSeriousViolations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const summary = bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, summary.join("\n")).toEqual([]);
}

test.describe("a11y smoke", () => {
  test("login page", async ({ anonContext }) => {
    const p = await anonContext.newPage();
    await p.goto("/de/login");
    await expect(p.getByRole("heading", { level: 1, name: "Anmelden" })).toBeVisible();
    await expectNoSeriousViolations(p);
  });

  test("trip page with plan", async ({ page, seed }) => {
    await page.goto(`/de/app/trips/${seed.a11yTripId}`);
    await expect(page.getByRole("heading", { name: "Reiseplan" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expectNoSeriousViolations(page);
  });

  test("shared plan page", async ({ anonContext, seed }) => {
    const p = await anonContext.newPage();
    await p.goto(`/de/s/${seed.a11yToken}`);
    await expect(p.getByRole("heading", { level: 1, name: "Advent auf der Donau" })).toBeVisible();
    await expectNoSeriousViolations(p);
  });
});
