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
