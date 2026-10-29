import { expect, test } from "./lib/fixtures";

// The plan is seeded from a recorded fixture; AI is off in E2E, so only the code-only actions are exercised.
test.describe("plan (no AI)", () => {
  test("renders the seeded plan and blocks AI changes", async ({ page, seed }) => {
    await page.goto(`/de/app/trips/${seed.tripId}`);
    await expect(page.getByRole("heading", { name: "Reiseplan" })).toBeVisible();
    await expect(page.getByText("Advent auf der Donau").first()).toBeVisible();
    await expect(page.getByText("KI-Änderungen sind derzeit abgeschaltet.")).toBeVisible();
  });

  test("swap days, set best day, browse versions", async ({ page, seed }) => {
    await page.goto(`/de/app/trips/${seed.tripId}`);
    const swap = page.getByRole("group", { name: "Tage tauschen" });
    await swap.getByRole("button", { name: "Tauschen" }).click();
    await expect(page.getByText("Tage 1 und 2 getauscht")).toBeVisible();
    await expect(page.getByText("Versionen (2)")).toBeVisible();

    const best = page.getByRole("group", { name: "Bester Tag" });
    await best.getByLabel("Tag").selectOption("4");
    await best.getByRole("button", { name: "Setzen" }).click();
    await expect(page.getByText("Tag 4 als bester Tag markiert")).toBeVisible();
    await expect(page.getByText("Versionen (3)")).toBeVisible();

    // Older version is read-only and reachable by link.
    await page.getByRole("link", { name: "Ansehen" }).last().click();
    await expect(page).toHaveURL(/[?&]v=1$/);
    await expect(page.getByText("Du siehst eine ältere Version.")).toBeVisible();
  });
});
