import { expect, test } from "./lib/fixtures";

const UNKNOWN = "A".repeat(43);

test("share link: visible logged out with noindex, PDFs download, revoke gives the same 404", async ({ page, seed, anonContext }, testInfo) => {
  await page.goto(`/de/app/trips/${seed.tripId}`);

  // Owner PDF: via the button (download) and directly (content type).
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF herunterladen" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  const own = await page.request.get(`/api/trips/${seed.tripId}/pdf`);
  expect(own.status()).toBe(200);
  expect(own.headers()["content-type"]).toContain("application/pdf");
  expect((await own.body()).subarray(0, 4).toString()).toBe("%PDF");

  // Create the link.
  await page.getByLabel("Name (optional)").fill(`E2E ${testInfo.project.name}`);
  await page.getByRole("button", { name: "Link erstellen" }).click();
  const url = await page.getByLabel(/Dein Link/).inputValue();
  const path = new URL(url).pathname;
  const token = path.split("/").pop()!;

  // Fresh logged-out context.
  const anon = await anonContext.newPage();
  const res = await anon.goto(path);
  expect(res?.status()).toBe(200);
  await expect(anon.getByRole("heading", { level: 1, name: "Advent auf der Donau" })).toBeVisible();
  await expect(anon.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  expect(anon.url()).not.toContain("/login");

  const sharePdf = await anonContext.request.get(`/api/share/${token}/pdf`);
  expect(sharePdf.status()).toBe(200);
  expect(sharePdf.headers()["content-type"]).toContain("application/pdf");
  expect((await sharePdf.body()).subarray(0, 4).toString()).toBe("%PDF");

  // Revoke.
  await page.getByRole("button", { name: /widerrufen/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Widerrufen", exact: true }).click();
  await expect(page.getByRole("button", { name: /widerrufen/ })).toHaveCount(0);

  const gone = await anon.goto(path);
  expect(gone?.status()).toBe(404);
  const goneText = await anon.locator("main").innerText();
  const never = await anon.goto(`/de/s/${UNKNOWN}`);
  expect(never?.status()).toBe(404);
  expect(await anon.locator("main").innerText()).toBe(goneText);
  expect((await anonContext.request.get(`/api/share/${token}/pdf`)).status()).toBe(404);
});
