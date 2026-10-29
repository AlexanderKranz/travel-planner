import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeStorageState } from "./lib/auth";
import { AUTH_DIR, PASSWORD, PROJECTS, SEED_FILE, emailOf, supabaseEnv, type Seed, type SeedFile } from "./lib/env";

const PASSAU = {
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

const must = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error || r.data === null) throw new Error(`${what}: ${r.error?.message ?? "no data"}`);
  return r.data;
};

async function ensureUser(sb: SupabaseClient, key: string, role: "user" | "admin", onboarded = true): Promise<string> {
  const email = emailOf(key);
  // The signup trigger is fail-closed: the allowlist row must exist first.
  const al = await sb.from("signup_allowlist").upsert({ email, note: "e2e" }, { onConflict: "email", ignoreDuplicates: true });
  if (al.error) throw new Error(`allowlist: ${al.error.message}`);
  let id: string | undefined;
  for (let page = 1; page < 20 && !id; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    id = data.users.find((u) => u.email === email)?.id;
    if (data.users.length < 200) break;
  }
  if (id) {
    const { error } = await sb.auth.admin.updateUserById(id, { password: PASSWORD, email_confirm: true });
    if (error) throw new Error(`updateUser: ${error.message}`);
  } else {
    const { data, error } = await sb.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error) throw new Error(`createUser: ${error.message}`);
    id = data.user.id;
  }
  // Seeded users have finished the getting-started guide; "s-<project>" has not (start.spec.ts).
  const p = await sb
    .from("profiles")
    .update({ role, display_name: key, locale: "de", home_airports: [], onboarding_done_at: onboarded ? new Date().toISOString() : null })
    .eq("id", id);
  if (p.error) throw new Error(`profile: ${p.error.message}`);
  // Start from a clean slate on re-runs.
  for (const t of ["trips", "travel_groups", "trip_purposes"]) {
    const d = await sb.from(t).delete().eq("owner_id", id);
    if (d.error) throw new Error(`wipe ${t}: ${d.error.message}`);
  }
  return id;
}

async function seedPlanTrip(sb: SupabaseClient, owner: string, title: string, plan: unknown): Promise<string> {
  const trip = must(
    await sb
      .from("trips")
      .insert({ owner_id: owner, title, ...PASSAU, length_days: 5, start_date: "2037-12-19", wants_flights: false })
      .select("id")
      .single<{ id: string }>(),
    "insert trip",
  );
  const p = must(await sb.from("plans").insert({ owner_id: owner, trip_id: trip.id }).select("id").single<{ id: string }>(), "insert plan");
  const v = await sb.from("plan_versions").insert({
    owner_id: owner,
    plan_id: p.id,
    kind: "generate",
    plan,
    input: { llm: { v: 1 }, index: {} },
    input_hash: "a".repeat(64),
    model: "claude-sonnet-5-5",
  });
  if (v.error) throw new Error(`insert plan_version: ${v.error.message}`);
  return trip.id;
}

export default async function globalSetup() {
  const { url, serviceKey } = supabaseEnv();
  const sb = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Recorded plan (generated from the cruise reference trip); the real LLM is never called in E2E.
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "src", "lib", "server", "__fixtures__", "plan-document-cruise.json"), "utf8"),
  ) as { plan: { days: { stops: { acts: { ref?: string; alts?: string[] }[] }[] }[]; places: Record<string, unknown> } };
  // The recorded plan has no alternatives; give the first place activity one (a second place that is already in the plan)
  // so the "remove alternative" edit has something to act on.
  const refs = Object.keys(fixture.plan.places);
  const firstAct = fixture.plan.days.flatMap((d) => d.stops.flatMap((st) => st.acts)).find((a) => a.ref && refs.some((r) => r !== a.ref));
  if (firstAct?.ref) firstAct.alts = [refs.find((r) => r !== firstAct.ref)!];

  const seed = {} as SeedFile;
  for (const proj of PROJECTS) {
    const a = await ensureUser(sb, `a-${proj}`, "user");
    await ensureUser(sb, `b-${proj}`, "user");

    const groupName = `Familie ${proj}`;
    const g = must(
      await sb.from("travel_groups").insert({ owner_id: a, name: groupName, trait_keys: [] }).select("id").single<{ id: string }>(),
      "insert group",
    );
    const entries = await sb.from("group_entries").insert(
      [
        { kind: "member", name: "Anna", birthdate: "1985-06-15", position: 0 },
        { kind: "member", name: "Mia", birthdate: "2020-05-01", position: 1 },
      ].map((e) => ({ ...e, group_id: g.id, owner_id: a })),
      { defaultToNull: false },
    );
    if (entries.error) throw new Error(`insert entries: ${entries.error.message}`);

    const tripId = await seedPlanTrip(sb, a, "E2E Plan", fixture.plan);
    const a11yTripId = await seedPlanTrip(sb, a, "E2E Share", fixture.plan);
    const token = randomBytes(32).toString("base64url");
    const sl = await sb.from("share_links").insert({
      owner_id: a,
      trip_id: a11yTripId,
      token_hash: createHash("sha256").update(token, "utf8").digest("hex"),
      label: "seed",
      include_items: true,
    });
    if (sl.error) throw new Error(`insert share link: ${sl.error.message}`);
    seed[proj] = { tripId, a11yTripId, a11yToken: token, groupId: g.id, groupName } satisfies Seed;

    await ensureUser(sb, `s-${proj}`, "user", false);
    await writeStorageState(`s-${proj}`);
    await writeStorageState(`a-${proj}`);
    await writeStorageState(`b-${proj}`);
  }
  await ensureUser(sb, "admin", "admin");
  await writeStorageState("admin");
  fs.writeFileSync(SEED_FILE, JSON.stringify(seed));
}
