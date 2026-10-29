import { expect, test } from "./lib/fixtures";

test.describe("admin area", () => {
  test("a normal user gets 404", async ({ page }) => {
    const res = await page.goto("/de/app/admin");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Admin", exact: true })).toHaveCount(0);
  });

  test("a signed-out visitor is sent to the login", async ({ anonContext }) => {
    const p = await anonContext.newPage();
    await p.goto("/de/app/admin");
    await expect(p).toHaveURL(/\/de\/login/);
  });

  test("the admin sees the aggregates page", async ({ contextAs }) => {
    const p = await (await contextAs("admin")).newPage();
    const res = await p.goto("/de/app/admin");
    expect(res?.status()).toBe(200);
    await expect(p.getByRole("heading", { level: 1, name: "Admin" })).toBeVisible();
  });
});
