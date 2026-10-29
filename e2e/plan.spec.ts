import { expect, test } from "./lib/fixtures";

// The plan is seeded from a recorded fixture; AI is off in E2E, so only the code-only actions are exercised.
// Specs run in file order on one seeded trip: each test starts from whatever the previous one left.
test.describe("plan (no AI)", () => {
  test("renders the seeded plan and blocks AI changes", async ({ page, seed }) => {
    await page.goto(`/de/app/trips/${seed.tripId}`);
    await expect(page.getByRole("heading", { name: "Reiseplan" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Tage" })).toContainText("Wien");
    await expect(page.getByText("KI-Änderungen sind derzeit abgeschaltet.")).toBeVisible();
    // No best-day marker until the user sets one (an AI `best` in old plans is ignored).
    await expect(page.getByRole("button", { name: /^Markierung „Bester Tag“/ })).toHaveCount(0);
  });

  test("remove an alternative without AI creates a version", async ({ page, seed }) => {
    await page.goto(`/de/app/trips/${seed.tripId}`);
    const remove = page.getByRole("button", { name: /^Alternative .+ entfernen$/ });
    await expect(remove).toHaveCount(1);
    await remove.click();
    await expect(page.getByText("Ohne KI: Alternative entfernt")).toBeVisible();
    await expect(page.getByText("Versionen (2)")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Alternative .+ entfernen$/ })).toHaveCount(0);
  });

  test("toggle the best day with the star in the day header", async ({ page, seed }) => {
    await page.goto(`/de/app/trips/${seed.tripId}`);
    await page.getByRole("button", { name: "Tag 3 als besten Tag markieren" }).click();
    await expect(page.getByText("Tag 3 als bester Tag markiert")).toBeVisible();
    await expect(page.getByText("Versionen (3)")).toBeVisible();
    const unmark = page.getByRole("button", { name: "Markierung „Bester Tag“ von Tag 3 entfernen" });
    await expect(unmark).toBeVisible();
    await unmark.click();
    await expect(page.getByText("bester Tag entfernt")).toBeVisible();
    await expect(page.getByText("Versionen (4)")).toBeVisible();
  });

  test("swap days and browse versions", async ({ page, seed }) => {
    await page.goto(`/de/app/trips/${seed.tripId}`);
    await page.getByRole("group", { name: "Tage tauschen" }).getByRole("button", { name: "Tauschen" }).click();
    await expect(page.getByText("Tage 1 und 2 getauscht")).toBeVisible();
    await expect(page.getByText("Versionen (5)")).toBeVisible();

    // Older version is read-only and reachable by link.
    await page.getByRole("link", { name: "Ansehen" }).last().click();
    await expect(page).toHaveURL(/[?&]v=1$/);
    await expect(page.getByText("Du siehst Version 1 (nur lesen).")).toBeVisible();
  });
});
