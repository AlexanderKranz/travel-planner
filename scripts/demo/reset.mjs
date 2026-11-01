// Creates or repairs the shared demo account and re-seeds its example data. Idempotent.
// Usage: npm run demo:reset   (reads .env.local, real environment variables win)
// Needs: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, DEMO_EMAIL, DEMO_PASSWORD.
// Uses the secret key (bypasses RLS) on purpose: it is an operator script, never imported by the app.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
// Node strips the types of seed.ts (Node >= 22.18 / 24). Pure builders, unit-tested in seed.test.ts.
import { buildExampleItems, buildExampleTrip, buildExampleVersion, EXAMPLE_GROUP } from "./seed.ts";

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));

const log = (msg) => console.log(`[demo:reset] ${msg}`);
function die(msg) {
  console.error(`[demo:reset] ERROR: ${msg}`);
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const email = process.env.DEMO_EMAIL?.trim().toLowerCase();
const password = process.env.DEMO_PASSWORD;
if (!email) die("DEMO_EMAIL is not set. Refusing to run.");
if (!password) die("DEMO_PASSWORD is not set.");
if (!url || !secretKey) die("NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY is not set.");

const sb = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
const check = (error, what) => {
  if (error) die(`${what} failed: ${error.message}`);
};

async function findUserByEmail(target) {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    check(error, "listing users");
    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

// 1. Allowlist (the signup trigger is fail-closed, so this must exist before the user is created).
{
  const { error } = await sb
    .from("signup_allowlist")
    .upsert({ email, note: "demo account" }, { onConflict: "email", ignoreDuplicates: true });
  check(error, "allowlist upsert");
  log("allowlist entry ensured");
}

// 2. User: create, or repair password/email/confirmation if a visitor changed them.
let user = await findUserByEmail(email);
if (!user) {
  const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
  check(error, "creating the demo user");
  user = data.user;
  log("demo user created");
} else {
  const { error } = await sb.auth.admin.updateUserById(user.id, { email, password, email_confirm: true });
  check(error, "resetting the demo user");
  log("demo user found, password and email reset");
}
const userId = user.id;

// 3. Profile
{
  const { error } = await sb
    .from("profiles")
    .update({
      is_demo: true,
      role: "user",
      display_name: "Demo",
      locale: "de",
      home_airports: ["FRA", "MUC"],
      // A home with coordinates, so the demo can try "Drive" in the destination search (GeoNames 2925533).
      home_location: "Frankfurt am Main, Hessen, Deutschland",
      home_timezone: "Europe/Berlin",
      home_geo_id: 2925533,
      home_lat: 50.11552,
      home_lon: 8.68417,
      birthdate: "1985-06-15",
    })
    .eq("id", userId);
  check(error, "profile update");
  log("profile set (is_demo, de, FRA/MUC, home Frankfurt)");
}

// 4. Example data: wipe, then insert.
{
  const t = await sb.from("trips").delete().eq("owner_id", userId); // before groups/purposes: keeps FK actions quiet
  check(t.error, "deleting demo trips");
  // Saved destination suggestions are not tied to a trip (nothing cascades from trips): delete them explicitly.
  const ds = await sb.from("destination_searches").delete().eq("owner_id", userId);
  check(ds.error, "deleting demo destination searches");
  const g = await sb.from("travel_groups").delete().eq("owner_id", userId);
  check(g.error, "deleting demo groups");
  const p = await sb.from("trip_purposes").delete().eq("owner_id", userId);
  check(p.error, "deleting demo purposes");
}

const today = new Date().toISOString().slice(0, 10);
const self = { kind: "member", is_self: true, position: 0 };

async function addGroup(name, notes, traitKeys, entries) {
  const { data, error } = await sb
    .from("travel_groups")
    .insert({ owner_id: userId, name, notes, trait_keys: traitKeys })
    .select("id")
    .single();
  check(error, `inserting group ${name}`);
  const rows = entries.map((e, i) => ({ ...e, position: i, group_id: data.id, owner_id: userId }));
  const res = await sb.from("group_entries").insert(rows, { defaultToNull: false }); // rows have different keys: omitted columns take their DB default
  check(res.error, `inserting entries of ${name}`);
}

await addGroup(
  "Familie mit Kleinkind",
  "Kleinkind braucht Mittagsschlaf; Buggy auf Kopfsteinpflaster ungeeignet.",
  ["mobility", "needsNap"],
  [
    { ...self },
    { kind: "member", name: "Partnerin", age_mode: "relativeToMe", notes: "Etwa gleich alt wie ich." },
    {
      kind: "member",
      name: "Kleinkind",
      age_mode: "approx",
      age: 1,
      age_as_of: today,
      notes: "Mittagsschlaf gegen 12:30 Uhr, ca. 2 Stunden.",
      traits: { needsNap: true, mobility: "stroller" },
    },
  ],
);
await addGroup("Golf-Duo", "Zwei Golfer, gleiche Altersklasse.", ["golfHandicap"], [
  { ...self, traits: { golfHandicap: 18 } },
  { kind: "member", name: "Golffreund", age_mode: "relativeToMe", traits: { golfHandicap: 24 } },
]);
// Free-text group (name + description only; the structured editor stays empty, no LLM parse is seeded).
const { data: freeTextGroup, error: freeTextErr } = await sb
  .from("travel_groups")
  .insert({ owner_id: userId, ...EXAMPLE_GROUP })
  .select("id")
  .single();
check(freeTextErr, "inserting the free-text group");
log("3 example groups inserted (one free text)");

const purposes = [
  {
    name: "Advents-Flusskreuzfahrt",
    text: "Advents-Flusskreuzfahrt mit Kleinkind. Weihnachtsmärkte, entspanntes Tempo, Mittagsschlaf an Bord einplanen.",
    constraints: ["feste Hafenzeiten", "Kleinkind braucht Mittagsschlaf", "früh dunkel"],
    guided: { v: 1, interests: ["christmas_markets", "cruise", "city_sightseeing"], pace: "relaxed" },
  },
  {
    name: "Golftrip",
    text: "Golftrip mit einem Freund: jeden Tag eine Runde, an einem Tag 36 Loch. Plätze nicht zu bergig. An- und Abreisetag sind Golftage.",
    constraints: [
      "täglich Golf, an einem Tag 36 Loch",
      "flache bis moderate Plätze",
      "maximal 3 Stunden Flug",
      "Einzelzimmer",
      "zentrale Basis, alle Plätze unter 1 Stunde Fahrt",
      "Mietwagen",
    ],
    guided: { v: 1, interests: ["golf"], rooms: "single_rooms" },
  },
];
const purposeIds = {};
{
  const { data, error } = await sb
    .from("trip_purposes")
    .insert(
      purposes.map((p) => ({ ...p, owner_id: userId })),
      { defaultToNull: false },
    )
    .select("id, name");
  check(error, "inserting purposes");
  for (const row of data) purposeIds[row.name] = row.id;
  log("2 example purposes inserted");
}

// 5. Example trips. The cruise uses a month only (no real date: it always points at the next December); the finished
// golf example uses the dates of the recorded plan (see ./seed.ts).
// Destination values are hard-coded from Open-Meteo geocoding (GeoNames ids, language=de) so the
// script needs no API call. Keep them in sync with docs/specs/phase-2-trips-facts.md section 8.
const PASSAU = {
  dest_geo_id: 2855328,
  dest_place_name: "Passau",
  dest_country_code: "DE",
  dest_admin1: "Bayern",
  dest_lat: 48.5665,
  dest_lon: 13.43122,
  dest_timezone: "Europe/Berlin",
};
{
  const groupIds = {};
  const { data: groups, error: gErr } = await sb.from("travel_groups").select("id, name").eq("owner_id", userId);
  check(gErr, "reading demo groups");
  for (const g of groups) groupIds[g.name] = g.id;

  const trips = [
    {
      title: "Advents-Donaukreuzfahrt",
      dest_kind: "city",
      dest_name: "Passau",
      ...PASSAU,
      dest_radius_km: null,
      length_days: 7,
      months: [12],
      group_id: groupIds["Familie mit Kleinkind"],
      purpose_id: purposeIds["Advents-Flusskreuzfahrt"],
      wants_flights: false,
      notes: "Passau – Wien – Budapest – Passau",
    },
  ];
  const { error } = await sb.from("trips").insert(
    trips.map((t) => ({ ...t, owner_id: userId })),
    { defaultToNull: false },
  );
  check(error, "inserting trips");
  log("1 example trip inserted");

  // Finished example trip: free-text group, purpose, cost items with a booked flight, and one plan version
  // seeded from the recorded eval plan (scripts/demo/example-plan.json). No LLM call, nothing in ai_usage.
  // No share link is created: the demo account cannot share (demo_forbidden).
  const example = JSON.parse(readFileSync(resolve(import.meta.dirname, "example-plan.json"), "utf8"));
  const { data: trip, error: tripErr } = await sb
    .from("trips")
    .insert(buildExampleTrip({ ownerId: userId, groupId: freeTextGroup.id, purposeId: purposeIds["Golftrip"] }))
    .select("id, updated_at")
    .single();
  check(tripErr, "inserting the example trip");
  const { data: grp, error: grpErr } = await sb.from("travel_groups").select("updated_at").eq("id", freeTextGroup.id).single();
  check(grpErr, "reading the example group");
  const { data: purp, error: purpErr } = await sb.from("trip_purposes").select("updated_at").eq("id", purposeIds["Golftrip"]).single();
  check(purpErr, "reading the example purpose");

  const items = await sb.from("trip_items").insert(buildExampleItems({ ownerId: userId, tripId: trip.id }), { defaultToNull: false });
  check(items.error, "inserting example items");
  const { data: plan, error: planErr } = await sb.from("plans").insert({ owner_id: userId, trip_id: trip.id }).select("id").single();
  check(planErr, "inserting the example plan");
  const version = await sb.from("plan_versions").insert(
    buildExampleVersion(example, { ownerId: userId, planId: plan.id }, {
      tripUpdatedAt: trip.updated_at,
      groupUpdatedAt: grp.updated_at,
      purposeUpdatedAt: purp.updated_at,
    }),
  );
  check(version.error, "inserting the example plan version");
  log("example trip with plan version, items and free-text group inserted");
}

log("done. Remember: DEMO_ENABLED=true must be set where the app runs.");
