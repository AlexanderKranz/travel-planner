import { startTripForm, submitTrip } from "./lib/trip-form";
import { expect, test } from "./lib/fixtures";

test.describe("trip creation", () => {
  test("trip without a group shows verified facts with their source", async ({ page }) => {
    await startTripForm(page, "geo");
    await submitTrip(page);
    await expect(page.getByRole("heading", { name: "Auf einen Blick" })).toBeVisible();
    // Facts come from the stubbed providers (recorded fixtures), each with source and check date.
    // visible: the destination summary is rendered twice (collapsed box on phones, side column on desktop).
    await expect(page.getByText(/Open-Meteo/).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/geprüft/).filter({ visible: true }).first()).toBeVisible();
  });

  test("free-text destination shows the unavailable state instead of invented facts", async ({ page }) => {
    await startTripForm(page, "freetext");
    await submitTrip(page);
    await expect(
      // visible: on phones the summary's copy of the message sits in the collapsed "Über das Reiseziel" box.
      page.getByText("Für dieses Ziel gibt es keine Wetter-, Tageslicht- oder Ortsdaten.").filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("trip with a quick group (free text plus composition)", async ({ page }) => {
    await startTripForm(page, "geo");
    await page.getByLabel("Reisegruppe (optional)").selectOption("__text");
    await page.getByLabel("Wer reist mit (nur diese Reise)?").fill("2 Erwachsene ~45");
    await page.getByRole("button", { name: /Mehrere Personen/ }).click();
    await page.getByLabel("Anzahl").fill("2");
    await page.locator("select").filter({ has: page.locator("option", { hasText: "Ungefähr" }) }).selectOption({ label: "Ungefähr" });
    await page.getByLabel("Alter in Jahren").fill("45");
    await submitTrip(page);
    await page.getByRole("link", { name: "Bearbeiten", exact: true }).first().click();
    await expect(page.getByLabel("Wer reist mit (nur diese Reise)?")).toHaveValue("2 Erwachsene ~45");
  });

  test("trip with a saved group of named members", async ({ page, seed }) => {
    await startTripForm(page, "geo");
    await page.getByLabel("Reisegruppe (optional)").selectOption(seed.groupId);
    await submitTrip(page);
    await page.getByRole("link", { name: "Bearbeiten", exact: true }).first().click();
    await expect(page.getByLabel("Reisegruppe (optional)")).toHaveValue(seed.groupId);
  });
});
