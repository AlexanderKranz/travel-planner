import { expect, test } from "./lib/fixtures";

// AI is off in E2E: only the saved-list path is tested (no model call, no external provider).
test.describe("find destinations", () => {
  test("the search form offers the saved purpose", async ({ page }) => {
    await page.goto("/de/app/trips/discover");
    await expect(page.getByRole("heading", { level: 1, name: "Reiseziele finden" })).toBeVisible();
    await expect(page.getByLabel("Reisezweck")).toContainText("Golf im Frühling");
    await expect(page.getByRole("button", { name: "Reiseziele finden" })).toBeVisible();
  });

  test("a saved list shows checked facts with source, the suggestion label and the limits footer", async ({ page, seed }) => {
    await page.goto(`/de/app/trips/discover/${seed.searchId}`);
    const card = page.getByRole("article", { name: "Passau" });
    await expect(card).toBeVisible();
    await expect(card.getByText(/Quelle:/).first()).toBeVisible();
    await expect(card.getByText("Weihnachtsmärkte: nicht geprüft")).toBeVisible();
    await expect(card.getByText("Nicht geprüft. Ein Vorschlag, keine Tatsache.")).toBeVisible();
    await expect(page.getByText(/Ein Direktflug ist nicht bestätigt/).first()).toBeVisible();
    await expect(page.getByText("2 zu weit für deine Flugzeit-Grenze")).toBeVisible();
    // One card is shown as is, with the note that nothing was added to fill the list.
    await expect(page.getByText(/Die Liste wurde nicht aufgefüllt/)).toBeVisible();
  });

  test("selecting a card opens the prefilled trip form without the reason", async ({ page, seed }) => {
    await page.goto(`/de/app/trips/discover/${seed.searchId}`);
    await page.getByRole("link", { name: "Reise nach Passau planen" }).click();
    await expect(page).toHaveURL(/\/app\/trips\/new\?search=.*&card=g2855328/);
    await expect(page.getByRole("button", { name: "Ändern" })).toBeVisible();
    await expect(page.getByLabel("Reisezweck")).toHaveValue(seed.purposeId);
    await expect(page.getByLabel("Titel")).toHaveValue("");
    await expect(page.getByText("Zurück zu den Vorschlägen").first()).toBeVisible();
  });
});
