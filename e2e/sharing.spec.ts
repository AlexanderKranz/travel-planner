import type { Page } from "@playwright/test";
import { emailOf } from "./lib/env";
import { startTripForm, submitTrip } from "./lib/trip-form";
import { expect, test } from "./lib/fixtures";

/**
 * Sharing between users (docs/specs/sharing.md section 5, E2E outline). A is the project's owner session, B the second
 * seeded user. AI is off in E2E, so "regenerate" and "by B" on a new version cannot run here (covered by the unit
 * tests of the pipeline); the demo scenario needs DEMO_ENABLED and is covered by the component test.
 */

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe.configure({ mode: "serial" });

test("trip: write share, downgrade to read, leave", async ({ page, seed, contextAs }, testInfo) => {
  const bEmail = emailOf(`b-${testInfo.project.name}`);
  await page.goto(`/de/app/trips/${seed.tripId}`);

  // Unknown address: the invite-only message, nothing is created.
  const box = page.getByTestId("people-share");
  await box.getByLabel("E-Mail-Adresse der Person").fill("nobody-here@e2e.test");
  await box.getByRole("button", { name: "Teilen", exact: true }).click();
  await expect(box.getByRole("alert")).toContainText("kein Konto");
  await box.getByLabel("E-Mail-Adresse der Person").fill(emailOf(`a-${testInfo.project.name}`));
  await box.getByRole("button", { name: "Teilen", exact: true }).click();
  await expect(box.getByRole("alert")).toContainText("eigene Adresse");

  // 1. Share with B, can edit.
  await box.getByLabel("E-Mail-Adresse der Person").fill(bEmail);
  await box.getByText("Darf bearbeiten", { exact: true }).click();
  await box.getByRole("button", { name: "Teilen", exact: true }).click();
  await expect(box.getByRole("status").filter({ hasText: "Geteilt." })).toBeVisible();
  await expect(box.getByText("Geteilt mit 1 von 10")).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await noHorizontalScroll(page);
    await testInfo.attach("share-box-360", { body: await box.screenshot(), contentType: "image/png" });
  }

  const b = await (await contextAs("b")).newPage();
  await b.goto("/de/app");
  const shared = b.getByTestId("shared-trips");
  await expect(shared.getByRole("heading", { name: "Mit mir geteilt" })).toBeVisible();
  await expect(shared.getByText(/· Darf bearbeiten/)).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await noHorizontalScroll(b);
    await testInfo.attach("badge-card-360", { body: await shared.screenshot(), contentType: "image/png" });
  }
  await shared.getByRole("link").first().click();
  await expect(b).toHaveURL(new RegExp(`/app/trips/${seed.tripId}$`));
  // Recipient: badge, no share panel for links, no delete, edit available.
  await expect(b.getByTestId("shared-header").getByText(/· Darf bearbeiten/)).toBeVisible();
  await expect(b.getByRole("button", { name: "Link erstellen" })).toHaveCount(0);
  await expect(b.getByTestId("people-share")).toHaveCount(0);
  await expect(b.getByRole("button", { name: "Löschen", exact: true })).toHaveCount(0);
  await expect(b.getByRole("button", { name: "PDF herunterladen" })).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await testInfo.attach("shared-trip-header-360", { body: await b.getByTestId("shared-header").screenshot(), contentType: "image/png" });
  }

  // B edits the title; the group and purpose are text, not fields.
  await b.getByRole("link", { name: "Bearbeiten", exact: true }).first().click();
  await expect(b.getByLabel("Reisegruppe (optional)")).toHaveCount(0);
  await expect(b.getByText(/Nur .* kann Gruppe und Reisezweck ändern/)).toBeVisible();
  await b.getByLabel("Titel (optional)").fill(`Geteilt ${testInfo.project.name}`);
  await b.getByRole("button", { name: "Speichern" }).click();
  await expect(b).toHaveURL(new RegExp(`/app/trips/${seed.tripId}$`));
  await expect(b.getByRole("heading", { level: 1, name: `Geteilt ${testInfo.project.name}` })).toBeVisible();

  // A sees the change.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: `Geteilt ${testInfo.project.name}` })).toBeVisible();

  // 2. A downgrades B to read-only.
  const row = page.getByTestId("people-share").getByRole("listitem").filter({ hasText: bEmail });
  await row.getByRole("combobox").selectOption("read");
  await expect(page.getByTestId("people-share").getByRole("status").filter({ hasText: "Zugriff geändert." })).toBeVisible();
  await b.reload();
  await expect(b.getByTestId("shared-header").getByText(/· Nur lesen/)).toBeVisible();
  await expect(b.getByRole("link", { name: "Bearbeiten", exact: true })).toHaveCount(0);
  await expect(b.getByRole("heading", { name: "Plan anpassen" })).toHaveCount(0);
  await expect(b.getByRole("button", { name: "Plan neu erstellen" })).toHaveCount(0);
  // The edit page sends a read grantee back to the trip.
  await b.goto(`/de/app/trips/${seed.tripId}/edit`);
  await expect(b).toHaveURL(new RegExp(`/app/trips/${seed.tripId}$`));
  // PDF for every access level.
  const pdf = await b.request.get(`/api/trips/${seed.tripId}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");

  // 4. B leaves; the trip is gone from the list and the page.
  await b.getByTestId("shared-header").getByRole("button", { name: "Verlassen" }).click();
  await b.getByRole("dialog").getByRole("button", { name: "Verlassen", exact: true }).click();
  await expect(b).toHaveURL(/\/de\/app$/);
  await expect(b.getByTestId("shared-trips")).toHaveCount(0);
  const gone = await b.goto(`/de/app/trips/${seed.tripId}`);
  expect(gone?.status()).toBe(404);

  // Restore the title for the specs that follow.
  await page.goto(`/de/app/trips/${seed.tripId}/edit`);
  await page.getByLabel("Titel (optional)").fill("");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/trips/${seed.tripId}$`));
});

test("purpose: share, pick it for an own trip, unshare", async ({ page, seed, contextAs }, testInfo) => {
  const bEmail = emailOf(`b-${testInfo.project.name}`);
  await page.goto(`/de/app/purposes/${seed.purposeId}`);
  const box = page.getByTestId("people-share");
  await expect(box.getByText(/Reisezweck für eigene Reisen und Zielsuchen nutzen/)).toBeVisible();
  await box.getByLabel("E-Mail-Adresse der Person").fill(bEmail);
  await box.getByRole("button", { name: "Teilen", exact: true }).click();
  await expect(box.getByRole("status").filter({ hasText: "Geteilt." })).toBeVisible();

  // B sees it in the list and can pick it for a new own trip.
  const b = await (await contextAs("b")).newPage();
  await b.goto("/de/app/purposes");
  await expect(b.getByTestId("shared-purposes").getByText(/· Nur lesen/)).toBeVisible();
  await startTripForm(b, "geo");
  const select = b.getByLabel("Reisezweck (optional)");
  const option = select.locator("optgroup[label='Mit mir geteilt'] option");
  await expect(option).toHaveCount(1);
  await select.selectOption({ index: await option.evaluate((el) => (el as HTMLOptionElement).index) });
  await submitTrip(b);
  const tripUrl = b.url();

  // Read-only purpose page for B: fields disabled, no save, no delete, no people box.
  await b.goto(`/de/app/purposes/${seed.purposeId}`);
  await expect(b.getByLabel("Name", { exact: true })).toBeDisabled();
  await expect(b.getByRole("button", { name: "Speichern" })).toHaveCount(0);
  await expect(b.getByRole("button", { name: "Reisezweck löschen" })).toHaveCount(0);
  await expect(b.getByTestId("people-share")).toHaveCount(0);

  // A unshares: B's trip keeps working without the purpose, and B's list loses the card.
  await page.reload();
  await page.getByTestId("people-share").getByRole("button", { name: /Zugriff für .* entfernen/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Entfernen", exact: true }).click();
  await expect(page.getByTestId("people-share").getByText("Noch mit niemandem geteilt.")).toBeVisible();
  await b.goto(tripUrl.replace(/^https?:\/\/[^/]+/, ""));
  await expect(b.getByRole("heading", { level: 1 })).toBeVisible();
  await b.goto("/de/app/purposes");
  await expect(b.getByTestId("shared-purposes")).toHaveCount(0);
});
