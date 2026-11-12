import { expect, test, withPageDump } from "./lib/fixtures";

/** City tours in the trip plan (docs/specs/city-tour.md section 10): day block, day action, public share page. */

test("owner sees the tour block in its day card and the day action", async ({ page, seed }) => {
  await page.goto(`/de/app/trips/${seed.a11yTripId}`);
  await withPageDump(page, async () => {
    const block = page.locator(`[data-tour-block="${seed.tourId}"]`);
    await expect(block).toBeVisible();
    await expect(block).toContainText("Stadttour · 10:00–11:43 · 3 Orte · 1,1 km zu Fuß");
    // In its day: the card of day 2.
    await expect(page.locator("#day-2").locator(`[data-tour-block="${seed.tourId}"]`)).toHaveCount(1);
    await block.locator("summary").click();
    await expect(block.getByText("Dom St. Stephan")).toBeVisible();
    await expect(block.locator("[data-route-sketch]")).toBeVisible();
    await expect(block.getByRole("link", { name: "Tour öffnen" })).toHaveAttribute("href", new RegExp(`/app/tours/${seed.tourId}$`));
    // Owner only: "Stadttour für diesen Tag" on every day card.
    const action = page.locator("#day-2").getByRole("link", { name: "Stadttour für diesen Tag" });
    await expect(action).toHaveAttribute("href", new RegExp(`/app/tours/new\\?trip=${seed.a11yTripId}&day=2$`));
  });
});

test("the public share page shows the tour block from the snapshot, without a link and without external requests", async ({ anonContext, seed }) => {
  const anon = await anonContext.newPage();
  const external: string[] = [];
  anon.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") external.push(host);
  });
  const res = await anon.goto(`/de/s/${seed.a11yToken}`);
  expect(res?.status()).toBe(200);
  const block = anon.locator(`[data-tour-block="${seed.tourId}"]`);
  await expect(block).toContainText("Stadttour · 10:00–11:43 · 3 Orte");
  await block.locator("summary").click();
  await expect(block.getByText("Ortspitze")).toBeVisible();
  await expect(block.getByRole("link", { name: "Tour öffnen" })).toHaveCount(0);
  await expect(anon.getByRole("link", { name: "Stadttour für diesen Tag" })).toHaveCount(0);
  expect(external).toEqual([]);
});
