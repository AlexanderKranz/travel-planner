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

// #164: with JavaScript on but the app scripts failing, a notice explains the disabled form (not only under <noscript>).
test("login: when the scripts do not load, a notice appears after a few seconds", async ({ anonContext }) => {
  await anonContext.route("**/_next/static/**/*.js", (route) => route.abort());
  const p = await anonContext.newPage();
  await p.goto("/de/login");
  const notice = p.locator(".load-notice");
  await expect(notice).toBeHidden();
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(notice).toContainText("JavaScript");
});

test("login: after hydration there is no load notice", async ({ anonContext }) => {
  const p = await anonContext.newPage();
  await p.goto("/de/login");
  await expect(p.locator("form[data-hydrated=true]").first()).toBeVisible();
  await expect(p.locator(".load-notice")).toHaveCount(0);
});
