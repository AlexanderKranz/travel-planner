import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, emailOf } from "./lib/env";

// Mail links must not spend the one-time token on GET (scanners, click trackers and web.de's redirector open
// them first). Only the button press (POST /auth/confirm) verifies. Needs a real browser because the POST's
// `Origin` header depends on the page's Referrer-Policy (no-referrer would send `Origin: null`).
test.use({ storageState: { cookies: [], origins: [] } });

const FAKE = "x".repeat(24);

async function postOf(page: Page) {
  return page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/auth/confirm");
}

test("confirm link: GET lands on the button page, headers are right, the POST carries the real origin", async ({ page }) => {
  const res = await page.goto(`/auth/confirm?token_hash=${FAKE}&type=recovery&locale=de`);
  expect(new URL(page.url()).pathname).toBe("/de/login/confirm");
  expect(new URL(page.url()).searchParams.get("token_hash")).toBe(FAKE);

  // Final response headers from next.config.ts.
  const h = res!.headers();
  expect(h["cache-control"]).toContain("no-store");
  expect(h["referrer-policy"]).toBe("same-origin");
  expect(h["x-robots-tag"]).toBe("noindex, nofollow");

  // No meta tag may weaken the policy; nothing on the page links off-site.
  const metas = await page.locator('meta[name="referrer"]').evaluateAll((els) => els.map((e) => e.getAttribute("content")));
  for (const c of metas) expect(c).toBe("same-origin");
  const hrefs = await page.locator("a[href]").evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).origin));
  for (const o of hrefs) expect(o).toBe(new URL(page.url()).origin);

  const button = page.getByRole("button", { name: "Weiter zum neuen Passwort" });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vw);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vw);

  // Compare with the origin the page is really on (a redirect may normalise 127.0.0.1 to localhost).
  const pageOrigin = new URL(page.url()).origin;
  const [req] = await Promise.all([postOf(page), button.click()]);
  const headers = await req.allHeaders();
  expect(headers.origin).toBe(pageOrigin);
  expect(headers.origin).not.toBe("null");
  // Fake token: verify fails, back to the login page with the generic error.
  await expect(page).toHaveURL(/\/de\/login\?error=link_invalid/);
});

test("confirm link works with JavaScript disabled", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: BASE_URL, javaScriptEnabled: false, locale: "de-DE" });
  const page = await ctx.newPage();
  await page.goto(`/auth/confirm?token_hash=${FAKE}&type=email&locale=en`);
  await expect(page).toHaveURL(/\/en\/login\/confirm/);
  const pageOrigin = new URL(page.url()).origin;
  const [req] = await Promise.all([postOf(page), page.getByRole("button", { name: "Sign in" }).click()]);
  expect((await req.allHeaders()).origin).toBe(pageOrigin);
  await expect(page).toHaveURL(/\/en\/login\?error=link_invalid/);
  await ctx.close();
});

test("confirm link: a cross-site Origin is refused", async ({ request }) => {
  const res = await request.post("/auth/confirm", {
    form: { token_hash: FAKE, type: "email", locale: "de" },
    headers: { origin: "https://evil.example" },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(303);
  expect(res.headers().location).toContain("/de/login?error=link_invalid");
});

test("recovery link: two GETs do not spend the token, the button does once", async ({ page, browser }) => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const up = await fetch(`${url}/auth/v1/health`).then((r) => r.status < 500, () => false);
  const key = process.env.SUPABASE_SECRET_KEY;
  test.skip(!url || !key || !up || !/127\.0\.0\.1|localhost/.test(url), "needs a running local Supabase");
  const sb = createClient(url!, key!, { auth: { autoRefreshToken: false, persistSession: false } });
  const email = emailOf(`a-${test.info().project.name}`);
  const { data, error } = await sb.auth.admin.generateLink({ type: "recovery", email });
  if (error) throw error;
  const hash = data.properties.hashed_token;
  const link = `/auth/confirm?token_hash=${hash}&type=recovery&locale=de`;

  // Scanner / redirector opens: twice, no cookies kept.
  for (let i = 0; i < 2; i++) {
    const ctx = await browser.newContext({ baseURL: BASE_URL });
    const r = await ctx.request.get(link);
    expect(r.status()).toBe(200);
    expect(r.url()).toContain("/de/login/confirm");
    await ctx.close();
  }

  await page.goto(link);
  await page.getByRole("button", { name: "Weiter zum neuen Passwort" }).click();
  await expect(page).toHaveURL(/\/de\/settings\?focus=password/);

  // Second press of the same token fails.
  const ctx2 = await browser.newContext({ baseURL: BASE_URL });
  const p2 = await ctx2.newPage();
  await p2.goto(link);
  await p2.getByRole("button", { name: "Weiter zum neuen Passwort" }).click();
  await expect(p2).toHaveURL(/\/de\/login\?error=link_invalid/);
  await ctx2.close();
});
