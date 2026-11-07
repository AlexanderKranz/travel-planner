import { emailOf } from "./lib/env";
import { startTripForm, submitTrip, TRIP_URL } from "./lib/trip-form";
import { expect, test } from "./lib/fixtures";

/**
 * One-off trip purpose (docs/specs/trip-purpose-text.md). AI is off in E2E, so nothing is tagged here; the tagging
 * runs in the unit tests. The text itself is stored, shown and cleared.
 */
const TEXT = "Ruhiger Geburtstag mit gutem Abendessen";

test.describe.configure({ mode: "serial" });

test("one-off purpose: create, edit, switch to a saved purpose clears it", async ({ page, seed }) => {
  await startTripForm(page, "geo");
  // The textarea only appears for the option; nothing is required.
  await expect(page.getByLabel("Wofür ist diese Reise?")).toHaveCount(0);
  await page.getByLabel("Reisezweck (optional)").selectOption("__text");
  await page.getByLabel("Wofür ist diese Reise?").fill(TEXT);
  await submitTrip(page);
  // The label is shown in the slot of a saved purpose's name.
  await expect(page.getByText(TEXT).first()).toBeVisible();

  const tripUrl = page.url();
  await page.getByRole("link", { name: "Bearbeiten", exact: true }).first().click();
  await expect(page.getByLabel("Reisezweck (optional)")).toHaveValue("__text");
  await expect(page.getByLabel("Wofür ist diese Reise?")).toHaveValue(TEXT);

  // Edit the text.
  await page.getByLabel("Wofür ist diese Reise?").fill(`${TEXT}, sonst ruhig`);
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page).toHaveURL(tripUrl);
  await page.getByRole("link", { name: "Bearbeiten", exact: true }).first().click();
  await expect(page.getByLabel("Wofür ist diese Reise?")).toHaveValue(`${TEXT}, sonst ruhig`);

  // Switching to a saved purpose clears the text.
  await page.getByLabel("Reisezweck (optional)").selectOption(seed.purposeId);
  await expect(page.getByLabel("Wofür ist diese Reise?")).toHaveCount(0);
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page).toHaveURL(tripUrl);
  await page.getByRole("link", { name: "Bearbeiten", exact: true }).first().click();
  await expect(page.getByLabel("Reisezweck (optional)")).toHaveValue(seed.purposeId);
  await page.getByLabel("Reisezweck (optional)").selectOption("__text");
  await expect(page.getByLabel("Wofür ist diese Reise?")).toHaveValue("");
});

test("one-off purpose: empty text means no purpose", async ({ page }) => {
  await startTripForm(page, "geo");
  await page.getByLabel("Reisezweck (optional)").selectOption("__text");
  await submitTrip(page);
  await page.getByRole("link", { name: "Bearbeiten", exact: true }).first().click();
  await expect(page.getByLabel("Reisezweck (optional)")).toHaveValue("");
});

test("shared trip shows the one-off purpose read-only", async ({ page, contextAs }, testInfo) => {
  test.setTimeout(150_000); // may wait out the per-minute share-lookup window (see below)
  await startTripForm(page, "geo");
  await page.getByLabel("Reisezweck (optional)").selectOption("__text");
  await page.getByLabel("Wofür ist diese Reise?").fill(TEXT);
  await submitTrip(page);
  const tripId = page.url().match(TRIP_URL) ? page.url().split("/").pop()! : "";

  // Right after creating the trip the page may not be hydrated yet (a controlled input filled before is reset), and the
  // box can remount while the page streams, so the status text is not reliable. The grant row in the list is.
  const box = page.getByTestId("people-share");
  const bEmail = emailOf(`b-${testInfo.project.name}`);
  // The form's controls are disabled until hydration (ClientForm), so Playwright waits instead of submitting natively.
  const row = box.getByRole("listitem").filter({ hasText: bEmail });
  await expect(box.locator('form[data-hydrated="true"]')).toBeVisible();
  await box.getByText("Darf bearbeiten", { exact: true }).click();
  await expect(box.getByRole("radio", { name: "Darf bearbeiten" })).toBeChecked();
  // The box can remount while the page streams (a remounted form is enabled at once and loses typed text): refill until it sticks.
  const emailInput = box.getByLabel("E-Mail-Adresse der Person");
  await expect(async () => {
    await emailInput.fill(bEmail);
    await expect(emailInput).toHaveValue(bEmail, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  // Earlier specs used up this user's per-minute lookup allowance (5, fixed 60 s window; the answer is the "too many
  // shares in a short time" alert, not a bug), so press again until the window has passed. A refused lookup does not share anything.
  await expect(async () => {
    await box.getByRole("button", { name: "Teilen", exact: true }).click();
    await expect(row).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 90_000, intervals: [2000, 5000] });

  const b = await (await contextAs("b")).newPage();
  await b.goto(`/de/app/trips/${tripId}`);
  await expect(b.getByTestId("group-block").getByText(TEXT).first()).toBeVisible();
  const overflow = await b.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Write grantee: the purpose is text, not a field.
  await b.getByRole("link", { name: "Bearbeiten", exact: true }).first().click();
  await expect(b.getByLabel("Reisezweck (optional)")).toHaveCount(0);
  await expect(b.getByLabel("Wofür ist diese Reise?")).toHaveCount(0);
  await expect(b.getByText(/Nur .* kann Gruppe und Reisezweck ändern/)).toBeVisible();
  await b.getByLabel("Titel (optional)").fill("Titel von B");
  await b.getByRole("button", { name: "Speichern" }).click();
  await expect(b).toHaveURL(new RegExp(`/app/trips/${tripId}$`));

  // The owner's text is untouched.
  await page.goto(`/de/app/trips/${tripId}/edit`);
  await expect(page.getByLabel("Wofür ist diese Reise?")).toHaveValue(TEXT);
});

test("a typed destination-search purpose fills the one-off purpose, notes stay empty", async ({ page, seed }) => {
  await page.goto(`/de/app/trips/discover/${seed.typedSearchId}`);
  await page.getByRole("link", { name: "Reise nach Passau planen" }).click();
  await expect(page).toHaveURL(/\/app\/trips\/new\?search=.*&card=g2855328/);
  await expect(page.getByLabel("Reisezweck (optional)")).toHaveValue("__text");
  await expect(page.getByLabel("Wofür ist diese Reise?")).toHaveValue("Ruhiges Abendessen zum Geburtstag");
  await expect(page.getByText(/Dein eingetippter Zweck aus der Zielsuche steht hier/)).toBeVisible();
  await expect(page.getByLabel("Notizen zu dieser Reise")).toHaveValue("");
});
