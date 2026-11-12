import { createClient } from "@supabase/supabase-js";
import type { Locator, Page } from "@playwright/test";
import path from "node:path";
import { PASSWORD, emailOf, supabaseEnv } from "./lib/env";
import { expect, test } from "./lib/fixtures";
import { startTripForm, submitTrip, TRIP_URL } from "./lib/trip-form";

/**
 * Trip stops ("Mehrere Stationen") and the itinerary upload (docs/specs/itinerary-upload.md). AI is off in E2E: the
 * upload runs on the browser parser only (0 tokens), which is the path these documents are built for. The documents
 * are the synthetic ones of the extraction eval (made-up ship, passenger and booking number).
 */

const DOCS = path.join(__dirname, "..", "evals", "fixtures", "itinerary");
const MULTI = /Mehrere Stationen/;

const rowsOf = (page: Page): Locator => page.locator("#field-stops li").filter({ has: page.locator('input[type="time"]') });

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function setDateMode(page: Page, startDate: string) {
  await page.locator("label", { hasText: /^Datum$/ }).click();
  await page.getByLabel("Startdatum").fill(startDate);
}

async function fillRow(row: Locator, v: { day?: number; place?: string; arr?: string; dep?: string; sea?: boolean }) {
  if (v.day) await row.getByLabel("Tag", { exact: true }).selectOption(String(v.day));
  if (v.sea) await row.getByLabel("Seetag").check();
  if (v.place !== undefined) await row.getByLabel("Ort", { exact: true }).fill(v.place);
  if (v.arr) await row.getByLabel("Ankunft").fill(v.arr);
  if (v.dep) await row.getByLabel("Abfahrt").fill(v.dep);
}

async function openEdit(page: Page) {
  await page.getByRole("link", { name: "Bearbeiten", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Speichern" })).toBeVisible();
}

async function saveEdit(page: Page) {
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page).toHaveURL(TRIP_URL);
}

test.describe.configure({ mode: "serial" });

test.describe("trip stops", () => {
  test("add, edit, remove stop rows; saved stops are there after a reload", async ({ page }) => {
    await startTripForm(page, "geo");
    await page.getByLabel("Dauer der Reise").fill("3");
    // The section is hidden until the box is ticked: a trip needs only a destination and a length.
    await expect(page.getByRole("button", { name: "Stopp hinzufügen" })).toHaveCount(0);
    await page.getByRole("checkbox", { name: MULTI }).check();
    await expect(page.getByText("Noch keine Stopps.")).toBeVisible();

    const add = page.getByRole("button", { name: "Stopp hinzufügen" });
    await add.click();
    await fillRow(rowsOf(page).nth(0), { day: 1, place: "Passau", dep: "16:00" });
    await add.click();
    await fillRow(rowsOf(page).nth(1), { day: 2, sea: true });
    await expect(rowsOf(page).nth(1).getByLabel("Ort", { exact: true })).toBeDisabled();
    await add.click();
    await fillRow(rowsOf(page).nth(2), { day: 3, place: "Wien", arr: "07:00" });
    await expect(rowsOf(page)).toHaveCount(3);
    await noHorizontalScroll(page); // 360 px: three stacked cards

    await submitTrip(page);
    await openEdit(page);
    await page.reload(); // a fresh read from the database, not the client state
    await expect(page.getByRole("checkbox", { name: MULTI })).toBeChecked();
    await expect(rowsOf(page)).toHaveCount(3);
    await expect(rowsOf(page).nth(0).getByLabel("Ort", { exact: true })).toHaveValue("Passau");
    await expect(rowsOf(page).nth(0).getByLabel("Abfahrt")).toHaveValue("16:00");
    await expect(rowsOf(page).nth(1).getByLabel("Seetag")).toBeChecked();
    await expect(rowsOf(page).nth(2).getByLabel("Ankunft")).toHaveValue("07:00");
    await expect(rowsOf(page).nth(2).getByLabel("Tag", { exact: true })).toHaveValue("3");
    await noHorizontalScroll(page);

    // Edit one row, remove another, save, and check again.
    await fillRow(rowsOf(page).nth(2), { place: "Linz" });
    await page.getByRole("button", { name: "Stopp 2 entfernen" }).click();
    await expect(rowsOf(page)).toHaveCount(2);
    await saveEdit(page);
    await openEdit(page);
    await expect(rowsOf(page)).toHaveCount(2);
    await expect(rowsOf(page).nth(1).getByLabel("Ort", { exact: true })).toHaveValue("Linz");
  });

  test("unticking with saved stops asks first; keep leaves them, remove clears them", async ({ page }) => {
    await startTripForm(page, "geo");
    await page.getByLabel("Dauer der Reise").fill("2");
    await page.getByRole("checkbox", { name: MULTI }).check();
    await page.getByRole("button", { name: "Stopp hinzufügen" }).click();
    await fillRow(rowsOf(page).nth(0), { day: 1, place: "Passau" });
    await submitTrip(page);
    await openEdit(page);

    const box = page.getByRole("checkbox", { name: MULTI });
    // click, not uncheck(): the box stays ticked until the user confirms, which uncheck() would report as a failure.
    await box.click();
    const dialog = page.getByRole("alertdialog", { name: "Gespeicherte Stopps entfernen?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Behalten" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(box).toBeChecked();
    await expect(rowsOf(page)).toHaveCount(1);

    await box.click();
    await dialog.getByRole("button", { name: "Ja, entfernen" }).click();
    await expect(box).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Stopp hinzufügen" })).toHaveCount(0);
    await noHorizontalScroll(page);
    await saveEdit(page);
    await openEdit(page);
    await expect(page.getByRole("checkbox", { name: MULTI })).not.toBeChecked();
    await expect(rowsOf(page)).toHaveCount(0);
  });

  test("a stop after the last day of the trip blocks saving until it fits", async ({ page }) => {
    await startTripForm(page, "geo");
    await page.getByLabel("Dauer der Reise").fill("3");
    await page.getByRole("checkbox", { name: MULTI }).check();
    await page.getByRole("button", { name: "Stopp hinzufügen" }).click();
    await fillRow(rowsOf(page).nth(0), { day: 3, place: "Passau" });

    await page.getByRole("button", { name: "Einen Tag weniger" }).click(); // 2 days: the stop on day 3 is outside
    await expect(rowsOf(page).nth(0).getByText("Liegt außerhalb der Reise")).toBeVisible();
    await page.getByRole("button", { name: "Reise anlegen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Bitte die markierten Stopps prüfen." })).toBeVisible();
    await expect(page).toHaveURL(/\/trips\/new$/); // nothing was saved

    await page.getByRole("button", { name: "Einen Tag mehr" }).click(); // 3 days again
    await expect(rowsOf(page).nth(0).getByText("Liegt außerhalb der Reise")).toHaveCount(0);
    await submitTrip(page);
  });

  test("upload a text PDF: the parser proposes the stops, dates are offered, Ersetzen replaces", async ({ page }) => {
    await startTripForm(page, "geo");
    await page.getByRole("checkbox", { name: MULTI }).check();
    const picker = page.locator('#field-stops input[type="file"]').first(); // the file picker (a camera input follows on phones)
    await expect(page.getByText("PDF oder Foto, bis 15 MB. Die Datei wird nicht gespeichert.")).toBeVisible();
    await picker.setInputFiles(path.join(DOCS, "donau-table.pdf"));

    await expect(page.getByText(/Erkannt: 6 Stopps\. Bitte prüfen\./)).toBeVisible({ timeout: 30_000 });
    await expect(rowsOf(page)).toHaveCount(6);
    await expect(rowsOf(page).nth(1).getByLabel("Ort", { exact: true })).toHaveValue("Wien");
    await expect(rowsOf(page).nth(1).getByLabel("Ankunft")).toHaveValue("14:00");
    await expect(rowsOf(page).nth(4).getByLabel("Ort", { exact: true })).toHaveValue("Linz");
    // Nothing is saved yet, and no AI ran: the parser path needs no token.
    await noHorizontalScroll(page);

    // The trip has no dates yet and the document prints some: the trip takes them (no offer left to click).
    await expect(page.getByLabel("Startdatum")).toHaveValue("2037-12-19");
    await expect(page.getByLabel("Dauer der Reise")).toHaveValue("5");
    await expect(page.getByRole("button", { name: /Reisedaten übernehmen/ })).toHaveCount(0);
    // A destination the user picked stays.
    await expect(page.getByRole("button", { name: "Ändern" })).toBeVisible();

    // With stops in the list a second upload is a proposal below them.
    await page.getByRole("button", { name: "Stopp 6 entfernen" }).click();
    await expect(rowsOf(page)).toHaveCount(5);
    await picker.setInputFiles(path.join(DOCS, "donau-prose.pdf"));
    const proposal = page.getByRole("group", { name: /Neu erkannt: 6 Stopps/ });
    await expect(proposal).toBeVisible({ timeout: 30_000 });
    await expect(proposal.getByRole("button", { name: "Fehlende Tage ergänzen" })).toBeVisible();
    await expect(proposal.getByRole("button", { name: "Verwerfen" })).toBeVisible();
    await noHorizontalScroll(page);
    await proposal.getByRole("button", { name: "Ersetzen" }).click();
    await expect(proposal).toHaveCount(0);
    await expect(rowsOf(page)).toHaveCount(6);

    await submitTrip(page);
    await openEdit(page);
    await expect(rowsOf(page)).toHaveCount(6);
    await expect(rowsOf(page).nth(2).getByLabel("Ort", { exact: true })).toHaveValue("Dürnstein");
    await expect(rowsOf(page).nth(2).getByLabel("Tag", { exact: true })).toHaveValue("3");
  });

  test("an upload fills an empty destination with the first port and sets the trip length", async ({ page }) => {
    await page.goto("/de/app/trips/new");
    await page.getByRole("checkbox", { name: MULTI }).check();
    await page.locator('#field-stops input[type="file"]').first().setInputFiles(path.join(DOCS, "donau-table.pdf"));
    await expect(page.getByText(/Erkannt: 6 Stopps\. Bitte prüfen\./)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Anzeigename")).toHaveValue(await rowsOf(page).nth(0).getByLabel("Ort", { exact: true }).inputValue());
    await expect(page.getByLabel("Dauer der Reise")).toHaveValue("5");
    await expect(page.getByLabel("Startdatum")).toHaveValue("2037-12-19");
    await noHorizontalScroll(page);
  });

  test("a document without a schedule says so, and an injected instruction never becomes a stop", async ({ page }) => {
    await startTripForm(page, "geo");
    await setDateMode(page, "2037-12-19");
    await page.getByLabel("Dauer der Reise").fill("5");
    await page.getByRole("checkbox", { name: MULTI }).check();
    const picker = page.locator('#field-stops input[type="file"]').first();

    await picker.setInputFiles(path.join(DOCS, "not-an-itinerary.pdf"));
    await expect(page.getByText("Keine Stopps gefunden. Du kannst sie unten eintippen.")).toBeVisible({ timeout: 30_000 });
    await expect(rowsOf(page)).toHaveCount(0);

    await picker.setInputFiles(path.join(DOCS, "injection.pdf"));
    // Either the parser reads the lines it understands or the AI-off message shows; Paris is never a stop.
    await expect(page.getByText("Dokument wird gelesen …")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator("#field-stops")).not.toContainText("Paris");
    for (const input of await rowsOf(page).getByLabel("Ort", { exact: true }).all()) {
      expect(await input.inputValue()).not.toMatch(/paris|ignore/i);
    }
  });

  test("a file that is not a PDF or an image is refused before anything is read", async ({ page }) => {
    await startTripForm(page, "geo");
    await page.getByRole("checkbox", { name: MULTI }).check();
    await page
      .locator('#field-stops input[type="file"]')
      .first()
      .setInputFiles({ name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("Sa 19.12. Passau") });
    await expect(page.getByText("Bitte PDF, JPG, PNG oder WebP verwenden.")).toBeVisible();
    await expect(rowsOf(page)).toHaveCount(0);
  });
});

test.describe("trip stops: isolation (docs/specs/itinerary-upload.md section 2)", () => {
  test("stranger and read grantee cannot change stops; read grantee has no edit form; extractions stay private", async ({ page, contextAs }, testInfo) => {
    const { url, anonKey, serviceKey } = supabaseEnv();
    const noSession = { auth: { autoRefreshToken: false, persistSession: false } };
    const admin = createClient(url, serviceKey, noSession);
    const b = createClient(url, anonKey, noSession);
    const a = createClient(url, anonKey, noSession);
    const signedB = await b.auth.signInWithPassword({ email: emailOf(`b-${testInfo.project.name}`), password: PASSWORD });
    expect(signedB.error).toBeNull();
    const signedA = await a.auth.signInWithPassword({ email: emailOf(`a-${testInfo.project.name}`), password: PASSWORD });
    expect(signedA.error).toBeNull();

    // A trip of A with stops, made through the form.
    await startTripForm(page, "geo");
    await page.getByLabel("Dauer der Reise").fill("2");
    await page.getByRole("checkbox", { name: MULTI }).check();
    await page.getByRole("button", { name: "Stopp hinzufügen" }).click();
    await fillRow(rowsOf(page).nth(0), { day: 1, place: "Passau", dep: "16:00" });
    await submitTrip(page);
    const tripId = page.url().match(/trips\/([0-9a-f-]{36})$/)![1];

    // Stranger: the trip and its stops are invisible; neither update nor insert lands.
    const seen = await b.from("trips").select("id, stops").eq("id", tripId);
    expect(seen.error).toBeNull();
    expect(seen.data).toEqual([]);
    const hijack = await b.from("trips").update({ stops: [{ day: 1, place: "Hijack" }] }).eq("id", tripId).select("id");
    expect(hijack.data ?? []).toEqual([]);
    const stranger = await (await contextAs("b")).newPage();
    const res = await stranger.goto(`/de/app/trips/${tripId}/edit`);
    expect(res?.status()).toBe(404);

    // Read grantee: reads the stops through the API, cannot write them, and is sent back from the edit form.
    const owner = await admin.from("trips").select("owner_id").eq("id", tripId).single<{ owner_id: string }>();
    expect(owner.error).toBeNull();
    const share = await admin
      .from("trip_shares")
      .insert({ owner_id: owner.data!.owner_id, trip_id: tripId, grantee_id: signedB.data.user!.id, access: "read" });
    expect(share.error).toBeNull();
    const readSeen = await b.from("trips").select("stops").eq("id", tripId).single<{ stops: { place: string }[] }>();
    expect(readSeen.data?.stops?.[0]?.place).toBe("Passau");
    const readWrite = await b.from("trips").update({ stops: [] }).eq("id", tripId).select("id");
    expect(readWrite.data ?? []).toEqual([]);
    await stranger.goto(`/de/app/trips/${tripId}/edit`);
    await expect(stranger).toHaveURL(new RegExp(`/app/trips/${tripId}$`));
    await expect(stranger.getByRole("checkbox", { name: MULTI })).toHaveCount(0);

    // Write grantee: may change the stops (not an owner-only column), through the form.
    const upgrade = await admin.from("trip_shares").update({ access: "write" }).eq("trip_id", tripId);
    expect(upgrade.error).toBeNull();
    await stranger.goto(`/de/app/trips/${tripId}/edit`);
    await expect(stranger.getByRole("checkbox", { name: MULTI })).toBeChecked();
    await expect(rowsOf(stranger)).toHaveCount(1);
    await stranger.getByRole("button", { name: "Stopp hinzufügen" }).click();
    await fillRow(rowsOf(stranger).nth(1), { day: 2, place: "Wien" });
    await stranger.getByRole("button", { name: "Speichern" }).click();
    await expect(stranger).toHaveURL(new RegExp(`/app/trips/${tripId}$`));
    const after = await a.from("trips").select("stops").eq("id", tripId).single<{ stops: unknown[] }>();
    expect(after.data?.stops).toHaveLength(2);

    // The extraction cache: only the server writes it, and nobody reads another user's rows.
    const planted = await a
      .from("itinerary_extracts")
      .insert({ owner_id: signedA.data.user!.id, hash: "a".repeat(64), stops: [] });
    expect(planted.error).not.toBeNull();
    const row = await admin
      .from("itinerary_extracts")
      .upsert({ owner_id: signedA.data.user!.id, hash: "c".repeat(64), stops: [{ day: 1, place: "Passau" }] }, { onConflict: "owner_id,hash" });
    expect(row.error).toBeNull();
    const mine = await a.from("itinerary_extracts").select("hash").eq("hash", "c".repeat(64));
    expect(mine.data).toHaveLength(1);
    const theirs = await b.from("itinerary_extracts").select("hash").eq("hash", "c".repeat(64));
    expect(theirs.data).toEqual([]);
    const wipe = await b.from("itinerary_extracts").delete().eq("hash", "c".repeat(64)).select("hash");
    expect(wipe.data ?? []).toEqual([]);
    await admin.from("itinerary_extracts").delete().eq("hash", "c".repeat(64));
  });
});
