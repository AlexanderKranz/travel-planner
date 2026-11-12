import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeStorageState } from "./lib/auth";
import { AUTH_DIR, PASSWORD, PROJECTS, SEED_FILE, emailOf, supabaseEnv, type Seed, type SeedFile } from "./lib/env";
import { encodePolyline } from "../src/lib/tour/polyline";

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

/** One recorded suggestion (Passau is the place the stubbed geocoder knows). */
const DISCOVER_CARD = {
  id: "g2855328",
  round: 1,
  name: "Passau",
  reason: "Drei Flüsse und schöne Ausflüge.",
  kind: "city",
  geoId: 2855328,
  placeName: "Passau",
  countryCode: "DE",
  admin1: "Bayern",
  place: { source: "geonames", fetchedAt: "2026-11-01T08:00:00Z", stale: false },
  flight: null,
  nearAirport: false,
  climate: { status: "not_checked" },
  pois: [{ status: "not_checked", interest: "christmas_markets" }],
};

/** Passau city tour points (public places, rounded coordinates; spec city-tour 14 spike points). */
const DOM = { key: "osm:w101", name: "Dom St. Stephan", lat: 48.5741, lon: 13.4648, source: "osm" };
const RATHAUS = { key: "osm:w102", name: "Rathaus", lat: 48.5746, lon: 13.4672, source: "osm" };
const ORTSPITZE = { key: "osm:n103", name: "Ortspitze", lat: 48.5737, lon: 13.4774, source: "osm" };
const tourLeg = (a: typeof DOM, b: typeof DOM, min: number, km: number) => ({
  from: a.key, to: b.key, mode: "foot", route: "fastest", min, km, s: "ok",
  poly: encodePolyline([[a.lat, a.lon], [b.lat, b.lon]]),
});

/**
 * A computed city tour on day 2 of the shared trip (city-tour 10). The result is a snapshot only the server writes;
 * the seed writes it with the secret key like the compute step does.
 */
async function seedTour(sb: SupabaseClient, owner: string, tripId: string): Promise<string> {
  return must(
    await sb
      .from("city_tours")
      .insert({
        owner_id: owner,
        trip_id: tripId,
        trip_day: 2,
        input: { places: [DOM, RATHAUS, ORTSPITZE], order: "optimize", mode: "foot", route: "fastest", startTime: "10:00", dwellDefaultMin: 30 },
        result: {
          v: 1,
          order: [DOM.key, RATHAUS.key, ORTSPITZE.key],
          legs: [tourLeg(DOM, RATHAUS, 4, 0.3), tourLeg(RATHAUS, ORTSPITZE, 9, 0.8)],
          totalMin: 103,
          fit: "none",
          sights: [],
          source: { ors: "2026-11-12T10:00:00.000Z" },
        },
        computed_at: "2026-11-12T10:00:00.000Z",
      })
      .select("id")
      .single<{ id: string }>(),
    "insert city tour",
  ).id;
}

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
    .update({ role, display_name: key, locale: "de", home_airports: [], birthdate: null, onboarding_done_at: onboarded ? new Date().toISOString() : null })
    .eq("id", id);
  if (p.error) throw new Error(`profile: ${p.error.message}`);
  // Start from a clean slate on re-runs.
  for (const t of ["trips", "city_tours", "destination_searches", "travel_groups", "trip_purposes"]) {
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

    const purposeId = must(
      await sb.from("trip_purposes").insert({ owner_id: a, name: "Golf im Frühling", text: "Golf spielen" }).select("id").single<{ id: string }>(),
      "insert purpose",
    ).id;
    const searchId = must(
      await sb
        .from("destination_searches")
        .insert({
          owner_id: a,
          purpose_id: purposeId,
          purpose_name: "Golf im Frühling",
          locale: "de",
          months: [3],
          origins: [],
          input_hash: createHash("sha256").update(`e2e-${proj}`).digest("hex"),
          input: { v: 1 },
          status: "done",
          cards: [DISCOVER_CARD],
          drops: { "1": { too_far: 2 } },
        })
        .select("id")
        .single<{ id: string }>(),
      "insert destination search",
    ).id;

    const typedSearchId = must(
      await sb
        .from("destination_searches")
        .insert({
          owner_id: a,
          purpose_id: null,
          purpose_text: "Ruhiges Abendessen zum Geburtstag",
          purpose_name: "Ruhiges Abendessen zum Geburtstag",
          locale: "de",
          months: [3],
          origins: [],
          input_hash: createHash("sha256").update(`e2e-typed-${proj}`).digest("hex"),
          input: { v: 1 },
          status: "done",
          cards: [DISCOVER_CARD],
          drops: {},
        })
        .select("id")
        .single<{ id: string }>(),
      "insert typed destination search",
    ).id;

    const tripId = await seedPlanTrip(sb, a, "E2E Plan", fixture.plan);
    const a11yTripId = await seedPlanTrip(sb, a, "E2E Share", fixture.plan);
    const tourId = await seedTour(sb, a, a11yTripId);
    const token = randomBytes(32).toString("base64url");
    const sl = await sb.from("share_links").insert({
      owner_id: a,
      trip_id: a11yTripId,
      token_hash: createHash("sha256").update(token, "utf8").digest("hex"),
      label: "seed",
      include_items: true,
    });
    if (sl.error) throw new Error(`insert share link: ${sl.error.message}`);
    seed[proj] = { purposeId, searchId, typedSearchId, tripId, a11yTripId, a11yToken: token, tourId, groupId: g.id, groupName } satisfies Seed;

    await ensureUser(sb, `s-${proj}`, "user", false);
    await writeStorageState(`s-${proj}`);
    await writeStorageState(`a-${proj}`);
    await writeStorageState(`b-${proj}`);
  }
  await ensureUser(sb, "admin", "admin");
  await writeStorageState("admin");
  fs.writeFileSync(SEED_FILE, JSON.stringify(seed));
}
