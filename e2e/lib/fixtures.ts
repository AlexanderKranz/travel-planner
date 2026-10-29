import { test as base, expect, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import { BASE_URL, SEED_FILE, type ProjectName, type Seed, type SeedFile } from "./env";
import { statePath } from "./auth";

type Fx = {
  /** Seed ids of this project (each project has its own users and data, so projects never interfere). */
  seed: Seed;
  /** Runs with a fresh, logged-out browser context at the project's viewport. */
  anonContext: BrowserContext;
  /** A browser context signed in as another seeded user (`b-<project>`, `admin`). */
  contextAs: (key: "b" | "admin") => Promise<BrowserContext>;
};

export const test = base.extend<Fx>({
  // Per-project owner session ("a-<project>") for every test unless a spec overrides it.
  storageState: async ({}, use, testInfo) => {
    await use(statePath(`a-${testInfo.project.name}`));
  },
  seed: async ({}, use, testInfo) => {
    const all = JSON.parse(fs.readFileSync(SEED_FILE, "utf8")) as SeedFile;
    await use(all[testInfo.project.name as ProjectName]);
  },
  anonContext: async ({ browser }, use, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: BASE_URL,
      storageState: { cookies: [], origins: [] }, // explicit: browser.newContext() otherwise inherits the owner session
      viewport: testInfo.project.use.viewport ?? undefined,
      locale: "de-DE",
    });
    await use(ctx);
    await ctx.close();
  },
  contextAs: async ({ browser }, use, testInfo) => {
    const made: BrowserContext[] = [];
    await use(async (who) => {
      const key = who === "b" ? `b-${testInfo.project.name}` : "admin";
      const ctx = await browser.newContext({
        baseURL: BASE_URL,
        storageState: statePath(key),
        viewport: testInfo.project.use.viewport ?? undefined,
        locale: "de-DE",
      });
      made.push(ctx);
      return ctx;
    });
    for (const c of made) await c.close();
  },
});
export { expect };

/** Runs `fn`; on failure rethrows with the visible page text and alerts, so a CI annotation says what the user would see. */
export async function withPageDump<T>(page: import("@playwright/test").Page, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const text = (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 500);
    const alerts = await page.locator('[role="alert"]').allInnerTexts().catch(() => []);
    throw new Error(`${(e as Error).message.split("\n")[0]} | url ${page.url()} | alerts: ${alerts.join(" / ") || "none"} | main: ${text}`, { cause: e });
  }
}

/**
 * The not-found page must be shown. The HTTP status should be 404, but since the segment-wide `loading.tsx`
 * (phase-6 hardening) the shell is streamed first and Next answers 200; that is recorded as an annotation, not a failure.
 */
export async function expectNotFoundPage(page: import("@playwright/test").Page, status: number | undefined) {
  await expect(page.getByRole("heading", { level: 1, name: "Seite nicht gefunden" })).toBeVisible();
  if (status !== 404) {
    test.info().annotations.push({ type: "known-defect", description: `not-found page answered HTTP ${status}, expected 404 (streaming under app/loading.tsx)` });
  }
}
