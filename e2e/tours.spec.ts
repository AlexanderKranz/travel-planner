import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import { statePath } from "./lib/auth";
import { TOURS_BASE_URL, emailOf, supabaseEnv } from "./lib/env";
import { expect, test, withPageDump } from "./lib/fixtures";

/**
 * City tours (docs/specs/city-tour.md, issue #172) on the tours server (port 3001: the same build with ORS and
 * Geoapify keys). e2e/stub-fetch.cjs answers Geoapify Autocomplete / Place Details and the ORS tour matrix and
 * directions with synthetic bodies in the recorded shapes (Passau spike points); no map tile is fetched
 * (TOUR_MAP_STYLE_URL=off), so the map shows its "Karte nicht verfügbar" fallback with the route sketch.
 * The trip-plan tests (section 10: day block, day action, public share page) run on the main server with the seeded tour.
 */
async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectNoSeriousViolations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const summary = bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, summary.join("\n")).toEqual([]);
}

async function addPlace(page: Page, query: string, name: RegExp) {
  const search = page.getByRole("combobox", { name: "Ort suchen" });
  await search.fill(query);
  await page.getByRole("option", { name }).click();
  await expect(search).toHaveValue("");
}

const PASSAU_TRIP = {
  dest_kind: "city",
  dest_name: "Passau",
  dest_geo_id: 2855328,
  dest_place_name: "Passau",
  dest_country_code: "DE",
  dest_admin1: "Bayern",
  dest_lat: 48.5665,
  dest_lon: 13.43122,
  dest_timezone: "Europe/Berlin",
};

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

test.describe("city tours (docs/specs/city-tour.md)", () => {
  test.use({ baseURL: TOURS_BASE_URL });

  test("create with 3 searched places, compute, change one leg, recompute; a trip grantee sees it read-only", async ({ page, browser }, testInfo) => {
    const project = testInfo.project.name;
    const { url, serviceKey } = supabaseEnv();
    const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    await page.goto("/de/app/tours/new");
    await expect(page.getByRole("heading", { level: 1, name: "Neue Stadttour" })).toBeVisible();
    await expect(page.locator('form[data-hydrated="true"]')).toBeVisible();

    // City (Open-Meteo, stubbed: Passau), then three places through the Geoapify search.
    await page.getByRole("combobox", { name: "Stadt (optional)" }).fill("Passau");
    await page.getByRole("option", { name: /^Passau/ }).first().click();
    await expect(page.getByTestId("tour-city")).toHaveText("Passau");
    await addPlace(page, "Dom", /Dom St\. Stephan/);
    await addPlace(page, "Rathaus", /Rathaus Passau/);
    await addPlace(page, "Ortspitze", /Ortspitze/);
    const places = page.getByTestId("tour-places").locator(":scope > li");
    await expect(places).toHaveCount(3);
    await expect(places.first()).toContainText("deine Schätzung");
    await page.getByText("Mehr Optionen").click();
    await expect(page.getByRole("combobox", { name: "Route" })).toBeVisible();
    await noHorizontalScroll(page);
    await expectNoSeriousViolations(page);

    // Plan: saved, computed on the server, shown on the same page under the tour's own address.
    await withPageDump(page, async () => {
      await page.getByTestId("tour-plan").click();
      await expect(page).toHaveURL(/\/de\/app\/tours\/[0-9a-f-]{36}$/, { timeout: 30_000 });
      await expect(page.getByTestId("tour-result")).toBeVisible({ timeout: 30_000 });
    });
    const tourId = page.url().split("/").pop()!;
    await expect(page.getByTestId("tour-total")).toContainText("Min.");
    const legs = page.getByTestId("tour-leg");
    await expect(legs).toHaveCount(2);
    await expect(legs.first()).toContainText("Schnellste");
    await expect(page.getByTestId("tour-stops").locator(":scope > li")).toHaveCount(3);
    await expect(page.getByTestId("tour-map-unavailable")).toContainText("Karte nicht verfügbar");
    await expect(page.getByRole("img", { name: "Routenskizze ohne Karte" })).toBeVisible();
    await expect(page.getByText("ohne Wartezeiten, Ampeln oder Andrang")).toBeVisible();
    await expect(page.getByRole("link", { name: /In Google Maps öffnen/ }).first()).toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\/dir\//);
    await noHorizontalScroll(page);
    await expectNoSeriousViolations(page);

    // One leg by bike on the quieter route: marked outdated until recomputed, then shown as an override.
    await page.getByRole("button", { name: /^Abschnitt .+ ändern$/ }).first().click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await sheet.locator("label", { hasText: "Fahrrad" }).click();
    await sheet.getByRole("combobox", { name: "Route" }).selectOption("quiet");
    await expect(sheet).toContainText("OpenStreetMap-Daten der Gegend");
    await noHorizontalScroll(page);
    await sheet.getByRole("button", { name: "Übernehmen" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("tour-outdated")).toBeVisible();
    await withPageDump(page, async () => {
      await page.getByRole("button", { name: "Tour neu berechnen" }).click();
      await expect(page.getByTestId("tour-outdated")).toBeHidden({ timeout: 30_000 });
    });
    await expect(legs).toHaveCount(2);
    await expect(legs.filter({ hasText: "abweichend" })).toHaveCount(1);
    await expect(legs.filter({ hasText: "Ruhiger" })).toHaveCount(1);
    await expect(page.getByTestId("tour-error")).toHaveCount(0);

    // Link the tour to a trip of the owner that is shared read-only with B.
    const owner = await admin.from("city_tours").select("owner_id").eq("id", tourId).single<{ owner_id: string }>();
    expect(owner.error).toBeNull();
    const tripTitle = `E2E Stadttour ${project}`;
    const trip = await admin
      .from("trips")
      .insert({ owner_id: owner.data!.owner_id, title: tripTitle, ...PASSAU_TRIP, length_days: 3, wants_flights: false })
      .select("id")
      .single<{ id: string }>();
    expect(trip.error).toBeNull();
    const users = await admin.auth.admin.listUsers({ perPage: 1000 });
    const grantee = users.data.users.find((u) => u.email === emailOf(`b-${project}`));
    expect(grantee).toBeDefined();
    const share = await admin.from("trip_shares").insert({ owner_id: owner.data!.owner_id, trip_id: trip.data!.id, grantee_id: grantee!.id, access: "read" });
    expect(share.error).toBeNull();

    // A reload renders the stored snapshot; then "Zu einer Reise hinzufügen".
    await page.reload();
    await expect(page.getByTestId("tour-result")).toBeVisible();
    await expect(page.getByTestId("tour-outdated")).toHaveCount(0);
    await page.getByText("Zu einer Reise hinzufügen").click();
    await page.getByRole("combobox", { name: "Reise", exact: true }).selectOption({ label: tripTitle });
    await page.getByRole("combobox", { name: "Tag", exact: true }).selectOption("1");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByText("Gespeichert.")).toBeVisible();

    // Grantee: the snapshot without edit or compute controls.
    const ctx = await browser.newContext({
      baseURL: TOURS_BASE_URL,
      storageState: statePath(`b-${project}`),
      viewport: testInfo.project.use.viewport ?? undefined,
      locale: "de-DE",
    });
    const reader = await ctx.newPage();
    await reader.goto(`/de/app/tours/${tourId}`);
    await expect(reader.getByTestId("tour-read-only")).toBeVisible();
    await expect(reader.getByTestId("tour-leg")).toHaveCount(2);
    await expect(reader.getByRole("link", { name: `Gehört zu „${tripTitle}“, Tag 1` })).toBeVisible();
    await expect(reader.getByRole("button", { name: /Tour (neu berechnen|planen)/ })).toHaveCount(0);
    await expect(reader.getByRole("button", { name: /^Abschnitt .+ ändern$/ })).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "Tour löschen" })).toHaveCount(0);
    await noHorizontalScroll(reader);
    await ctx.close();

    // The tour is listed on /app/tours and in the /app section.
    await page.goto("/de/app/tours");
    await expect(page.getByRole("link", { name: /Passau · 3 Orte/ })).toBeVisible();
    await page.goto("/de/app");
    await expect(page.getByRole("heading", { name: "Stadttouren" })).toBeVisible();
    // Desktop: the tours are their own column between the trips and the groups/purposes, and all three columns start
    // on the same line (Alex, 2026-11-12). Phones: the tours follow the trips.
    const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
    const trips = await box('main section[aria-label="Reisen"]');
    if ((page.viewportSize()?.width ?? 0) >= 1024) {
      const tours = await box('section[aria-labelledby="side-tours"]');
      const side = await box('section[aria-labelledby="side-tours"] + div');
      expect(tours.x).toBeGreaterThan(trips.x + trips.width - 1);
      expect(side.x).toBeGreaterThan(tours.x + tours.width - 1);
      expect(Math.abs(tours.y - trips.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(side.y - trips.y)).toBeLessThanOrEqual(2);
    } else {
      const tours = await box('section[aria-labelledby="dashboard-tours"]');
      expect(tours.y).toBeGreaterThan(trips.y);
    }
    await noHorizontalScroll(page);
  });
});
