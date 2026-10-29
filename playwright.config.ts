import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./e2e/lib/env";

// Needs a running local Supabase and a production build: see docs/runbook.md "E2E tests".
// Each project has its own users and data (e2e/global-setup.ts), so the two never interfere.
const CI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  // One worker: the flows of a project build on seeded state (items -> plan -> share) in file order.
  workers: 1,
  fullyParallel: false,
  retries: CI ? 1 : 0,
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
  webServer: {
    // The preload stubs all external providers (e2e/stub-fetch.cjs). It exists only in this command.
    command: "node --require ./e2e/stub-fetch.cjs node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000",
    url: `${BASE_URL}/de/login`,
    reuseExistingServer: !CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
    env: {
      APP_URL: BASE_URL,
      AI_ENABLED: "false",
      ANTHROPIC_API_KEY: "",
      AERODATABOX_API_KEY: "",
      OPENROUTESERVICE_API_KEY: "",
      DEMO_ENABLED: "false",
      NEXT_PUBLIC_SENTRY_DSN: "",
      INTEGRATIONS_CONTACT: "e2e@example.invalid",
    },
  },
});
