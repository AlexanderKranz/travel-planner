import { expect, type Page } from "@playwright/test";

export const TRIP_URL = /\/app\/trips\/[0-9a-f-]{36}$/;

/** Opens the new-trip form and picks Passau from the (stubbed) geocoder. */
export async function startTripForm(page: Page, destination: "geo" | "freetext") {
  await page.goto("/de/app/trips/new");
  const search = page.getByRole("combobox", { name: "Ziel suchen" });
  if (destination === "geo") {
    await search.fill("Passau");
    await page.getByRole("option", { name: /Passau/ }).first().click();
    await expect(page.getByRole("button", { name: "Ändern" })).toBeVisible();
  } else {
    await search.fill("Nirgendwo");
    await page.getByRole("option", { name: /als Freitext verwenden/ }).click();
    await expect(page.getByLabel("Anzeigename")).toHaveValue("Nirgendwo");
  }
}

export async function submitTrip(page: Page) {
  await page.getByRole("button", { name: "Reise anlegen" }).click();
  await expect(page).toHaveURL(TRIP_URL, { timeout: 30_000 });
}
