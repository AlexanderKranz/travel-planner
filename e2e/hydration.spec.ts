import { expect, test } from "./lib/fixtures";

// Regression guard for #159: with the JS chunks blocked the page never hydrates. A submit must then not go native
// (page reload with the field values in the URL).
test("login: before hydration the submit button is disabled and nothing lands in the URL", async ({ anonContext }) => {
  await anonContext.route("**/_next/static/**/*.js", (route) => route.abort());
  const p = await anonContext.newPage();
  await p.goto("/de/login");
  const submit = p.locator('form button[type="submit"]').first();
  await expect(submit).toBeDisabled();
  const email = p.locator('form input[type="email"]').first();
  await email.fill("nobody@example.test");
  await email.press("Enter");
  await submit.click({ force: true });
  await p.waitForTimeout(500);
  const url = new URL(p.url());
  expect(url.pathname).toBe("/de/login");
  expect(url.search).not.toContain("email");
});
