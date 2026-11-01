import { expect, test, withPageDump } from "./lib/fixtures";

test("a booked cost item with times shows in the costs and as a fixed row in the day plan", async ({ page, seed }) => {
  await page.goto(`/de/app/trips/${seed.tripId}`);
  // Collapsed until the first entry.
  await page.locator("#items-title").click();
  await page.getByRole("button", { name: "Kostenpunkt hinzufügen", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Titel", { exact: true }).fill("Stadtführung E2E");
  await dialog.getByLabel("Status", { exact: true }).selectOption({ label: "Gebucht" });
  await dialog.getByLabel("Preis", { exact: true }).fill("250,00");
  await dialog.getByLabel("Tag", { exact: true }).selectOption({ label: "Tag 2" });
  await dialog.getByLabel("Beginn", { exact: true }).fill("10:00");
  await dialog.getByLabel("Ende", { exact: true }).fill("12:00");
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toBeHidden();

  const items = page.getByRole("region", { name: "Buchungen und Kosten" });
  await withPageDump(page, () => expect(items.getByText("Stadtführung E2E").first()).toBeVisible());
  await expect(items.getByRole("region", { name: "Kostenübersicht" })).toContainText(/250,00\s*€/);
  // Fixed row inside the day plan (booked + day + start time).
  const fixed = page.locator("[data-fixed-item]");
  await expect(fixed).toHaveCount(1);
  await expect(fixed).toContainText("Stadtführung E2E");
});
