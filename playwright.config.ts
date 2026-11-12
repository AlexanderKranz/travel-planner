import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, TOURS_BASE_URL } from "./e2e/lib/env";

// Needs a running local Supabase and a production build: see docs/runbook.md "E2E tests".
// Each project has its own users and data (e2e/global-setup.ts), so the two never interfere.
const CI = !!process.env.CI;

const SERVER_ENV = {
  AI_ENABLED: "false",
  ANTHROPIC_API_KEY: "",
  AERODATABOX_API_KEY: "",
  OPENROUTESERVICE_API_KEY: "",
  GEOAPIFY_API_KEY: "",
  DEMO_ENABLED: "false",
  NEXT_PUBLIC_SENTRY_DSN: "",
  INTEGRATIONS_CONTACT: "e2e@example.invalid",
  // The tour map never loads tiles in E2E: it shows "Karte nicht verfügbar" and the route sketch.
  TOUR_MAP_STYLE_URL: "off",
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  // One worker: the flows of a project build on seeded state (items -> plan -> share) in file order.
  workers: 1,
  fullyParallel: false,
  // No retries: several flows change data (swap days, items, share links), so a retry would not start from the seed.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // "github" turns failures into annotations on the CI run (readable without a log download).
  reporter: CI ? [["list"], ["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    locale: "de-DE",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Optional: use a locally installed browser, e.g. PW_CHANNEL=chrome
    channel: process.env.PW_CHANNEL || undefined,
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 360, height: 800 } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: [
    {
      // The preload stubs all external providers (e2e/stub-fetch.cjs). It exists only in this command.
      command: "node --require ./e2e/stub-fetch.cjs node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000",
      url: `${BASE_URL}/de/login`,
      reuseExistingServer: !CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
      env: { ...SERVER_ENV, APP_URL: BASE_URL },
    },
    {
      // City tours (e2e/tours.spec.ts): the same build with ORS and Geoapify keys, answered by the stub. A second
      // server keeps the keys away from the other specs (with a Geoapify key, trip places would take another path).
      command: "node --require ./e2e/stub-fetch.cjs node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3001",
      url: `${TOURS_BASE_URL}/de/login`,
      reuseExistingServer: !CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
      env: { ...SERVER_ENV, APP_URL: TOURS_BASE_URL, OPENROUTESERVICE_API_KEY: "e2e-stub", GEOAPIFY_API_KEY: "e2e-stub" },
    },
  ],
});
