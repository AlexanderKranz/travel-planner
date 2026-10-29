import { expect, test } from "./lib/fixtures";

test.describe("getting started", () => {
  test("a new user lands on the guide once; skipping it goes to the trips list", async ({ contextAs }) => {
    const ctx = await contextAs("s");
    const page = await ctx.newPage();
    await page.goto("/de/app");
    await expect(page).toHaveURL(/\/de\/app\/start$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Erste Schritte");
    await page.getByRole("button", { name: "Einführung überspringen" }).click();
    await expect(page).toHaveURL(/\/de\/app\/trips$/);
    await page.goto("/de/app");
    await expect(page).not.toHaveURL(/\/app\/start$/);
  });

  test("users who finished the guide are not redirected", async ({ page }) => {
    await page.goto("/de/app");
    await expect(page).not.toHaveURL(/\/app\/start$/);
  });
});
