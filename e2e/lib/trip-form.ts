import { expect, type Page } from "@playwright/test";

export const TRIP_URL = /\/app\/trips\/[0-9a-f-]{36}$/;

/** Collects what the geocode proxy answered, so a failure message says why no suggestion appeared. */
const geocodeLog = new WeakMap<Page, string[]>();

/** Opens the new-trip form and picks Passau from the (stubbed) geocoder. */
export async function startTripForm(page: Page, destination: "geo" | "freetext") {
  const log: string[] = [];
  geocodeLog.set(page, log);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  page.on("response", async (r) => {
    if (r.url().includes("/api/geocode")) log.push(`${r.status()} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  });
  await page.goto("/de/app/trips/new");
  const search = page.getByRole("combobox", { name: "Ziel suchen" });
  if (destination === "geo") {
    await search.fill("Passau");
    const option = page.getByRole("option", { name: /Passau/ }).first();
    await expect(option, `geocode answers: ${log.join(" || ") || "none"}; status: ${await page.locator('[role="status"]').allInnerTexts()}`).toBeVisible();
    await option.click();
    try {
      await expect(page.getByRole("button", { name: "Ändern" })).toBeVisible();
    } catch (e) {
      const body = (await page.locator("form").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 700);
      throw new Error(`destination not picked; page errors: ${errors.join(" | ") || "none"}; form text: ${body}`, { cause: e });
    }
  } else {
    await search.fill("Nirgendwo");
    await page.getByRole("option", { name: /als Freitext verwenden/ }).click();
    await expect(page.getByLabel("Anzeigename")).toHaveValue("Nirgendwo");
  }
}

export async function submitTrip(page: Page) {
  await page.getByRole("button", { name: "Reise anlegen" }).click();
  try {
    await expect(page).toHaveURL(TRIP_URL, { timeout: 30_000 });
  } catch (e) {
    const alerts = await page.locator('[role="alert"]').allInnerTexts();
    throw new Error(`trip was not created (url ${page.url()}; alerts: ${alerts.join(" | ") || "none"}; geocode: ${(geocodeLog.get(page) ?? []).join(" || ")})`, { cause: e });
  }
}
