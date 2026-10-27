// Creates or repairs the shared demo account and re-seeds its example data. Idempotent.
// Usage: npm run demo:reset   (reads .env.local, real environment variables win)
// Needs: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, DEMO_EMAIL, DEMO_PASSWORD.
// Uses the secret key (bypasses RLS) on purpose: it is an operator script, never imported by the app.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

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
      birthdate: "1985-06-15",
    })
    .eq("id", userId);
  check(error, "profile update");
  log("profile set (is_demo, de, FRA/MUC)");
}

// 4. Example data: wipe, then insert.
{
  const g = await sb.from("travel_groups").delete().eq("owner_id", userId);
  check(g.error, "deleting demo groups");
  const p = await sb.from("trip_purposes").delete().eq("owner_id", userId);
  check(p.error, "deleting demo purposes");
}

const today = new Date().toISOString().slice(0, 10);
const self = { kind: "member", is_self: true, position: 0 };

async function addGroup(name, notes, entries) {
  const { data, error } = await sb
    .from("travel_groups")
    .insert({ owner_id: userId, name, notes })
    .select("id")
    .single();
  check(error, `inserting group ${name}`);
  const rows = entries.map((e, i) => ({ ...e, position: i, group_id: data.id, owner_id: userId }));
  const res = await sb.from("group_entries").insert(rows);
  check(res.error, `inserting entries of ${name}`);
}

await addGroup(
  "Familie mit Kleinkind",
  "Kleinkind braucht Mittagsschlaf; Buggy auf Kopfsteinpflaster ungeeignet.",
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
    },
  ],
);
await addGroup("Golf-Duo", "Zwei Golfer, gleiche Altersklasse.", [
  { ...self },
  { kind: "member", name: "Golffreund", age_mode: "relativeToMe" },
]);
log("2 example groups inserted");

const purposes = [
  {
    name: "Advents-Flusskreuzfahrt",
    text: "Advents-Flusskreuzfahrt mit Kleinkind. Weihnachtsmärkte, entspanntes Tempo, Mittagsschlaf an Bord einplanen.",
    constraints: ["feste Hafenzeiten", "Kleinkind braucht Mittagsschlaf", "früh dunkel"],
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
  },
];
{
  const { error } = await sb.from("trip_purposes").insert(purposes.map((p) => ({ ...p, owner_id: userId })));
  check(error, "inserting purposes");
  log("2 example purposes inserted");
}

log("done. Remember: DEMO_ENABLED=true must be set where the app runs.");
