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
    await expect(page.getByRole("region", { name: "Reisekontext" })).toBeVisible();
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
    const ctx = page.getByRole("region", { name: "Reisekontext" });
    await expect(ctx.getByRole("link", { name: "Nur für diese Reise" })).toBeVisible();
    await expect(ctx).toContainText("45");
  });

  test("trip with a saved group of named members", async ({ page, seed }) => {
    await startTripForm(page, "geo");
    await page.getByLabel("Reisegruppe (optional)").selectOption(seed.groupId);
    await submitTrip(page);
    const ctx = page.getByRole("region", { name: "Reisekontext" });
    await expect(ctx.getByRole("link", { name: seed.groupName })).toBeVisible();
    await expect(ctx).toContainText("Anna");
    await expect(ctx).toContainText("Mia");
  });
});
