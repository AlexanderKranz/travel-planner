import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import { emailOf, supabaseEnv } from "./lib/env";
import { startTripForm, submitTrip } from "./lib/trip-form";
import { expect, test } from "./lib/fixtures";

/**
 * Group sharing (docs/specs/group-sharing.md section 5, E2E outline). A is the project's owner session, B the second
 * seeded user. The spec makes its own group (A as the `is_self` entry, typed entries "Ben" and "Kim") with the service
 * key so the seeded group of the other specs stays untouched, and removes it at the end. There is no third seeded user,
 * so "second claim refused" is the same user claiming a second entry from a stale tab (`already_claimed`); the
 * `already_linked` race between two users is covered by the concurrency script of the migration.
 */

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const service = () => {
  const { url, serviceKey } = supabaseEnv();
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
};

const previousBirthdate = new Map<string, string | null>();
const nameOf = (project: string) => `Teilgruppe ${project}`;

/** The spec's group is found by name, so a restarted worker (after a failure) still finds and removes it. */
async function findGroup(project: string, ownerId?: string) {
  const sb = service();
  let q = sb.from("travel_groups").select("id, owner_id").eq("name", nameOf(project));
  if (ownerId) q = q.eq("owner_id", ownerId);
  const r = await q.limit(1).maybeSingle<{ id: string; owner_id: string }>();
  return r.data ? { id: r.data.id, owner: r.data.owner_id } : null;
}

async function ensureGroup(project: string, seedGroupId: string) {
  const known = await findGroup(project);
  if (known) return known;
  const sb = service();
  const owner = (await sb.from("travel_groups").select("owner_id").eq("id", seedGroupId).single<{ owner_id: string }>()).data!.owner_id;
  // The owner's profile birthdate is what recipients see on the is_self entry (decision A). The previous value is
  // restored in afterAll; global-setup also resets it.
  const prev = await sb.from("profiles").select("birthdate").eq("id", owner).single<{ birthdate: string | null }>();
  previousBirthdate.set(owner, prev.data?.birthdate ?? null);
  await sb.from("profiles").update({ birthdate: "1980-05-05" }).eq("id", owner);
  const g = await sb.from("travel_groups").insert({ owner_id: owner, name: nameOf(project), trait_keys: [] }).select("id").single<{ id: string }>();
  if (g.error) throw new Error(g.error.message);
  const e = await sb.from("group_entries").insert(
    [
      { kind: "member", is_self: true, position: 0 },
      { kind: "member", name: "Ben", birthdate: "1990-03-03", position: 1 },
      { kind: "member", name: "Kim", birthdate: "1992-04-04", position: 2 },
    ].map((x) => ({ ...x, group_id: g.data!.id, owner_id: owner })),
    { defaultToNull: false },
  );
  if (e.error) throw new Error(e.error.message);
  return { id: g.data!.id, owner };
}

test.describe.configure({ mode: "serial" });

test("group: share read-only, upgrade to write, B edits, A sees it", async ({ page, seed, contextAs }, testInfo) => {
  const project = testInfo.project.name;
  const g = await ensureGroup(project, seed.groupId);
  const bEmail = emailOf(`b-${project}`);

  await page.goto(`/de/app/groups/${g.id}`);
  const box = page.getByTestId("people-share");
  await expect(box.getByText(/einen Eintrag als sich selbst markieren/)).toBeVisible();
  await box.getByLabel("E-Mail-Adresse der Person").fill(bEmail);
  await box.getByText("Darf ansehen", { exact: true }).click();
  await box.getByRole("button", { name: "Teilen", exact: true }).click();
  await expect(box.getByRole("status").filter({ hasText: "Geteilt." })).toBeVisible();
  if (project === "mobile") {
    await noHorizontalScroll(page);
    await testInfo.attach("group-share-box-360", { body: await box.screenshot(), contentType: "image/png" });
  }
  // The own groups list shows the pill.
  await page.goto("/de/app/groups");
  await expect(page.getByRole("link", { name: new RegExp(`Teilgruppe ${project}`) }).getByText("Geteilt · 1")).toBeVisible();

  // B, read-only: listed under "Mit mir geteilt", read-only view with birthdates, A as group owner, no edit controls.
  const b = await (await contextAs("b")).newPage();
  await b.goto("/de/app/groups");
  const shared = b.getByTestId("shared-groups");
  await expect(shared.getByText(/· Nur lesen/)).toBeVisible();
  await shared.getByRole("link", { name: new RegExp(`Teilgruppe ${project}`) }).click();
  const view = b.getByTestId("group-view");
  await expect(view).toBeVisible();
  await expect(view.getByText(`a-${project} (Besitzer der Gruppe)`)).toBeVisible();
  await expect(view.getByText(/geb\. 05\.05\.1980/)).toBeVisible(); // the owner's birthdate on the is_self entry
  await expect(view.getByText(/geb\. 03\.03\.1990/)).toBeVisible();
  await expect(b.getByRole("button", { name: "Speichern" })).toHaveCount(0);
  await expect(b.getByRole("button", { name: "Gruppe löschen" })).toHaveCount(0);
  await expect(b.getByTestId("people-share")).toHaveCount(0);
  await expect(b.getByRole("button", { name: "Das bin ich" })).toHaveCount(2); // Ben and Kim, not the owner's entry
  await expect(b.getByTestId("shared-header").getByRole("button", { name: "Verlassen" })).toBeVisible();

  // A upgrades B to write.
  await page.goto(`/de/app/groups/${g.id}`);
  const row = page.getByTestId("people-share").getByRole("listitem").filter({ hasText: bEmail });
  await row.getByRole("combobox").selectOption("write");
  await expect(page.getByTestId("people-share").getByRole("status").filter({ hasText: "Zugriff geändert." })).toBeVisible();

  // B, write: the editor; owner-only controls are gone.
  await b.reload();
  await expect(b.getByTestId("group-view")).toHaveCount(0);
  await expect(b.getByRole("button", { name: "Gruppe löschen" })).toHaveCount(0);
  await expect(b.getByRole("button", { name: "+ Ich" })).toHaveCount(0);
  await expect(b.getByText(`a-${project} (Besitzer der Gruppe)`)).toBeVisible();
  await expect(b.getByText(/Nur .* kann ändern, wer „ich“ ist\./)).toBeVisible();
  await b.getByLabel("Name der Gruppe").fill(`Geteilt ${project}`);
  await b.getByRole("button", { name: "Speichern" }).click();
  await expect(b.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
  if (project === "mobile") {
    await noHorizontalScroll(b);
    await testInfo.attach("group-editor-recipient-360", { body: await b.screenshot({ fullPage: true }), contentType: "image/png" });
  }

  // A sees the change, then B's stale tab saving over a newer version gets the conflict notice and "Save anyway".
  await page.reload();
  await expect(page.getByLabel("Name der Gruppe")).toHaveValue(`Geteilt ${project}`);
  await page.getByLabel("Name der Gruppe").fill(`Teilgruppe ${project}`);
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
  await b.getByLabel("Name der Gruppe").fill(`Von B ${project}`);
  await b.getByRole("button", { name: "Speichern" }).click();
  await expect(b.getByRole("alert").filter({ hasText: /zwischenzeitlich/ })).toBeVisible();
  await b.getByRole("button", { name: "Trotzdem speichern" }).click();
  await expect(b.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Name der Gruppe")).toHaveValue(`Von B ${project}`);
  await page.getByLabel("Name der Gruppe").fill(`Teilgruppe ${project}`);
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
});

test("group: That's me, second claim refused, undo, owner removes the link", async ({ page, seed, contextAs }, testInfo) => {
  const project = testInfo.project.name;
  const g = await ensureGroup(project, seed.groupId);
  const ctx = await contextAs("b");
  const b = await ctx.newPage();
  const stale = await ctx.newPage();
  await b.goto(`/de/app/groups/${g.id}`);
  await stale.goto(`/de/app/groups/${g.id}`);
  await expect(b.getByRole("button", { name: "Das bin ich" })).toHaveCount(2);
  await expect(stale.getByRole("button", { name: "Das bin ich" })).toHaveCount(2);

  // B marks Ben (first typed entry): "You" and "That's not me"; no other entry offers "That's me".
  await b.getByRole("button", { name: "Das bin ich" }).first().click();
  await expect(b.getByRole("button", { name: "Das bin nicht ich" })).toHaveCount(1);
  await expect(b.getByRole("button", { name: "Das bin ich" })).toHaveCount(0);
  await expect(b.getByTestId("entry-link").getByText("Du", { exact: true })).toBeVisible();
  if (project === "mobile") {
    await noHorizontalScroll(b);
    const box = await b.getByRole("button", { name: "Das bin nicht ich" }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  // The stale tab still offers "That's me" on Kim: the server refuses (one entry per user), the tab reloads.
  await stale.getByRole("button", { name: "Das bin ich" }).last().click();
  await expect(stale.getByRole("alert").filter({ hasText: "schon einen anderen Eintrag markiert" })).toBeVisible();
  await expect(stale.getByRole("button", { name: "Das bin ich" })).toHaveCount(0);

  // A sees "{name} check" on Ben, "You" on the own entry, and no mark on Kim.
  await page.goto(`/de/app/groups/${g.id}`);
  await expect(page.getByText(`b-${project} ✓`)).toBeVisible();
  await expect(page.getByRole("button", { name: `Verknüpfung entfernen: b-${project}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Das bin ich" })).toHaveCount(0); // the owner never claims
  if (project === "mobile") {
    await noHorizontalScroll(page);
    await testInfo.attach("group-owner-link-360", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }

  // B undoes; the buttons come back.
  await b.getByRole("button", { name: "Das bin nicht ich" }).click();
  await expect(b.getByRole("button", { name: "Das bin ich" })).toHaveCount(2);
  await page.reload();
  await expect(page.getByText(`b-${project} ✓`)).toHaveCount(0);

  // B claims again, the owner removes the link, B can claim right away.
  await b.getByRole("button", { name: "Das bin ich" }).first().click();
  await expect(b.getByRole("button", { name: "Das bin nicht ich" })).toHaveCount(1);
  await page.reload();
  await page.getByRole("button", { name: `Verknüpfung entfernen: b-${project}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Verknüpfung entfernen", exact: true }).click();
  await expect(page.getByText(`b-${project} ✓`)).toHaveCount(0);
  await b.reload();
  await expect(b.getByRole("button", { name: "Das bin ich" })).toHaveCount(2);
  await expect(b.getByRole("button", { name: "Das bin nicht ich" })).toHaveCount(0);
});

test("group: B uses the shared group for an own trip, claims there, A unshares", async ({ page, seed, contextAs }, testInfo) => {
  const project = testInfo.project.name;
  const g = await ensureGroup(project, seed.groupId);
  const b = await (await contextAs("b")).newPage();

  await startTripForm(b, "geo");
  const select = b.getByLabel("Reisegruppe (optional)");
  const option = select.locator("optgroup[label='Mit mir geteilt'] option");
  await expect(option).toHaveCount(1);
  await select.selectOption({ index: await option.evaluate((el) => (el as HTMLOptionElement).index) });
  await submitTrip(b);
  const tripPath = b.url().replace(/^https?:\/\/[^/]+/, "");

  // The group block of B's own trip: A as the group owner with name and birthdate, link buttons, 360 px clean.
  const block = b.getByTestId("group-block");
  await expect(block.getByText(`a-${project} (Besitzer der Gruppe)`)).toBeVisible();
  await expect(block.getByText(/geb\. 05\.05\.1980/)).toBeVisible();
  await expect(block.getByRole("button", { name: "Das bin ich" })).toHaveCount(2);
  if (project === "mobile") await noHorizontalScroll(b);
  await block.getByRole("button", { name: "Das bin ich" }).first().click();
  await expect(block.getByRole("button", { name: "Das bin nicht ich" })).toBeVisible();
  await block.getByRole("button", { name: "Das bin nicht ich" }).click();
  await expect(block.getByRole("button", { name: "Das bin ich" })).toHaveCount(2);

  // The search form offers the group too.
  await b.goto("/de/app/trips/discover");
  await expect(b.getByLabel("Reisegruppe (optional)").locator("optgroup[label='Mit mir geteilt'] option")).toHaveCount(1);

  // A unshares: B's trip keeps working without the group, the list loses the card.
  await page.goto(`/de/app/groups/${g.id}`);
  await page.getByTestId("people-share").getByRole("button", { name: /Zugriff für .* entfernen/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Entfernen", exact: true }).click();
  await expect(page.getByTestId("people-share").getByText("Noch mit niemandem geteilt.")).toBeVisible();
  await b.goto(tripPath);
  await expect(b.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(b.getByTestId("group-block")).toHaveCount(0);
  await b.goto("/de/app/groups");
  await expect(b.getByTestId("shared-groups")).toHaveCount(0);
  const gone = await b.goto(`/de/app/groups/${g.id}`);
  expect(gone?.status()).toBe(404);
});

test.afterAll(async ({}, testInfo) => {
  const g = await findGroup(testInfo.project.name);
  if (!g) return;
  const sb = service();
  await sb.from("travel_groups").delete().eq("id", g.id);
  // Back to what it was; after a worker restart the map is empty and the seeded value (null, reset by global-setup) applies.
  await sb.from("profiles").update({ birthdate: previousBirthdate.get(g.owner) ?? null }).eq("id", g.owner);
});
