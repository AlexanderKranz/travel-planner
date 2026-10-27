# Phase 1 spec: data model, auth, health check, airports

Status: proposed (architect, 2026-10-27). Decisions and their reasons: `docs/adr/0001-phase-1-data-model.md`.
Implemented by `backend-dev` (migrations, RLS, routes), `frontend-dev` (forms), `devops` (health route, Auth settings).

Scope: auth + roles, invite allowlist, profiles, travel groups, trip purposes, `app_events`, health check, airport autocomplete.
Not in phase 1: `trips`, `plan_versions`, `share_links` (phase 2/3/5), `api_cache` + `api_calls` (phase 2), `ai_usage` (phase 3), admin views (phase 6).

---

## 1. Conventions for every migration

- Schemas: app tables in `public` (exposed through the Data API, guarded by RLS). Helper functions and triggers in a new schema `private`, which is **not** exposed by the Data API.
- IDs: `uuid primary key default gen_random_uuid()` for user content; `bigint generated always as identity` for logs.
- Timestamps: `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` kept by trigger `private.set_updated_at()`.
- Dates (birthdates, as-of dates) are `date`, exchanged as `YYYY-MM-DD`.
- Every user-content table has `owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade`. Deleting the auth user deletes all of that user's content.
- RLS enabled on **every** table in `public`, no exceptions. Policies use `(select auth.uid())` (evaluated once per query, not per row).
- Explicit grants instead of relying on Supabase's defaults. Supabase grants ALL on new public tables to `anon` and `authenticated`, which makes column-level grants ineffective, so: the base migration runs `alter default privileges in schema public revoke all on tables/sequences/functions from anon, authenticated`, and every table migration runs `revoke all on table public.X from anon, authenticated, public;` followed by exactly the grants needed (column-level insert/update for `profiles`, `trip_purposes`, `signup_allowlist`, `travel_groups`, `group_entries`).
- Text length limits are enforced in the DB (`check (char_length(x) <= n)`) **and** in Zod. Business rules that change (allowed locales, valid IATA codes, number of entries per group) live only in Zod.

### Standard owner policies (template)
Used for `travel_groups`, `group_entries`, `trip_purposes` (and later `trips`, `plan_versions`):

```sql
alter table public.X enable row level security;
revoke all on public.X from anon, public;
grant select, insert, update, delete on public.X to authenticated;

create policy "X: owner select" on public.X for select to authenticated
  using ((select auth.uid()) = owner_id);
create policy "X: owner insert" on public.X for insert to authenticated
  with check ((select auth.uid()) = owner_id);
create policy "X: owner update" on public.X for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "X: owner delete" on public.X for delete to authenticated
  using ((select auth.uid()) = owner_id);
```

**Admin rule:** there are no admin policies on content tables (profiles, groups, entries, purposes). Admins get aggregates only, through `security definer` functions/views in phase 6 that check `private.is_admin()` and return counts, never rows. Admins read `app_events` and manage `signup_allowlist` (metadata, not content).

---

## 2. Tables

### 2.1 `profiles`
One row per auth user, created by trigger (section 4). The PK is the user id, so the RLS column is `id` (the one exception to the `owner_id` name).

| Column | Type | Null | Default | Constraint / note |
|---|---|---|---|---|
| `id` | uuid | no | — | PK, `references auth.users(id) on delete cascade` |
| `role` | text | no | `'user'` | `check (role in ('user','admin'))` |
| `display_name` | text | yes | — | `char_length <= 80`. Filled from Google metadata later |
| `locale` | text | no | `'de'` | `check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$')`; app validates against `routing.locales` |
| `home_airports` | text[] | no | `'{}'` | ordered, most preferred first; `check (cardinality(home_airports) <= 5 and array_to_string(home_airports, ',') ~ '^([A-Z]{3}(,[A-Z]{3})*)?$')` |
| `birthdate` | date | yes | — | the user's own birthdate; drives `relativeToMe` and the "self" group member. `check (birthdate >= '1900-01-01')` |
| `created_at`, `updated_at` | timestamptz | no | `now()` | |

RLS and grants:
```sql
revoke all on public.profiles from anon, public;
grant select on public.profiles to authenticated;
grant update (display_name, locale, home_airports, birthdate) on public.profiles to authenticated;  -- NOT role
create policy "profiles: self select" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "profiles: self update" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
-- no insert policy (trigger creates rows), no delete policy (account deletion = delete auth user via secret key → cascade)
```
The column-level grant is what stops a user from promoting themselves to admin. Roles change only via SQL / a secret-key server route. Bootstrap Alex as admin with a one-off SQL statement documented in `docs/runbook.md` (never put an email address in a migration).

```sql
create function private.is_admin() returns boolean
  language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') $$;
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;
```

### 2.2 `signup_allowlist`
Invite-only signup. An email may create an account only if it is listed here.

| Column | Type | Null | Default | Constraint / note |
|---|---|---|---|---|
| `id` | bigint identity | no | — | PK |
| `email` | citext | no | — | `unique`; `check (email = lower(email) and position('@' in email) > 1)` |
| `note` | text | yes | — | e.g. "Schwester"; `char_length <= 200` |
| `invited_by` | uuid | yes | `auth.uid()` | `references public.profiles(id) on delete set null` |
| `used_at` | timestamptz | yes | — | set by the signup trigger; "pending invites" = `used_at is null` |
| `created_at` | timestamptz | no | `now()` | |

RLS: admins only (`using (private.is_admin())` for select/insert/delete; no update). No access for normal users or `anon`. `citext` is created in schema `extensions`.

### 2.3 `travel_groups`

| Column | Type | Null | Default | Constraint / note |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `owner_id` | uuid | no | `auth.uid()` | FK `auth.users`, cascade |
| `name` | text | no | — | `char_length between 1 and 80` (e.g. "Familie", "Golf mit Tom") |
| `notes` | text | yes | — | free-text group notes, `char_length <= 2000` |
| `trait_keys` | text[] | no | `'{}'` | which optional entry details (traits) this group uses; subset of `mobility, diet, golfHandicap, needsNap` (no duplicates, CHECK; adding a trait needs a migration + `TRAIT_KEYS`). Migration 20261028120010 |
| `created_at`, `updated_at` | timestamptz | no | `now()` | |

Traits are chosen once per group: on create/update the server strips every entry's `traits` to the group's `trait_keys` (`stripTraits()` in `src/lib/group.ts`), so no hidden data remains after a detail is deselected.

Also `unique (id, owner_id)` (target of the composite FK below). Index: `(owner_id, updated_at desc)`. Standard owner policies.
A group may be completely empty (only a name, or name + notes): all context is optional.

### 2.4 `group_entries` (one table, `kind` discriminator)
Each row is either a quick composition entry (`kind = 'composition'`, any `count`) or a named member (`kind = 'member'`, always one person). Both share age, label, notes and traits, so "my son, about 4" (named member without birthdate) works.

| Column | Type | Null | Default | Constraint / note |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `group_id` | uuid | no | — | see composite FK |
| `owner_id` | uuid | no | `auth.uid()` | FK `auth.users`, cascade |
| `kind` | text | no | — | `check (kind in ('composition','member'))` |
| `position` | smallint | no | `0` | display order across both kinds |
| `count` | smallint | no | `1` | `check (count between 1 and 50)` |
| `label` | text | yes | — | "Eltern", "Kleinkind", "Sohn", "Golfer"; `<= 60` |
| `name` | text | yes | — | member only; `<= 80` |
| `is_self` | boolean | no | `false` | member only: "me"; name and birthdate come from `profiles` |
| `birthdate` | date | yes | — | member only; `>= '1900-01-01'` |
| `age_mode` | text | yes | — | `check (age_mode in ('exact','approx','relativeToMe'))`; null = age not given |
| `age` | smallint | yes | — | stated age, `check (age between 0 and 120)` |
| `age_as_of` | date | yes | — | date the age was stated (set by the server on save) |
| `notes` | text | yes | — | mobility, diet, "needs nap" …; `<= 1000` |
| `traits` | jsonb | no | `'{}'` | optional structured traits, Zod `EntryTraits`; `check (jsonb_typeof(traits) = 'object')` |
| `created_at`, `updated_at` | timestamptz | no | `now()` | |

Integrity:
```sql
foreign key (group_id, owner_id) references public.travel_groups (id, owner_id) on delete cascade,
-- kind rules
check (kind = 'member' or (count >= 1 and name is null and birthdate is null and not is_self)),
check (kind = 'composition' or count = 1),
check (kind = 'composition' or is_self or name is not null),
check (not is_self or (name is null and birthdate is null and age_mode is null)),
-- age rules (ages are never stored for people with a birthdate)
check (birthdate is null or age_mode is null),
check (age_mode is not null or (age is null and age_as_of is null)),
check (age_mode not in ('exact','approx') or (age is not null and age_as_of is not null)),
check (age_mode <> 'relativeToMe' or (age is null and age_as_of is null))
```
The composite FK guarantees an entry always belongs to a group of the same owner, so the plain owner policies are sufficient.
Indexes: `(group_id, position)`; `unique (group_id) where is_self` (at most one "me" per group).

Age resolution for a travel date (code, `src/lib/group.ts`, never stored):
- `birthdate` set → `ageOn(birthdate, date)`
- `is_self` → `ageOn(profile.birthdate, date)`, or "unknown" if the profile has none
- `exact` / `approx` → `age + wholeYearsBetween(age_as_of, date)` (approx stays approximate: "~46")
- `relativeToMe` → same as self, marked approximate; "about my age" if the profile has no birthdate
- `age_mode` null → no age; `label` (e.g. "Kleinkind") is passed through as is

### 2.5 `trip_purposes`

| Column | Type | Null | Default | Constraint / note |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `owner_id` | uuid | no | `auth.uid()` | FK `auth.users`, cascade |
| `name` | text | no | — | "Golftrip", "Advent cruise"; `char_length between 1 and 80` |
| `text` | text | yes | — | free-text description, `<= 4000` |
| `guided` | jsonb | no | `'{}'` | wizard answers, Zod `PurposeGuided`; `check (jsonb_typeof(guided) = 'object')` |
| `constraints` | text[] | no | `'{}'` | must-haves / hard constraints, one per item, ordered; `check (cardinality(constraints) <= 30)`; each item `<= 200` chars (Zod) |
| `parsed_tags` | jsonb | yes | — | **phase 3**: Haiku output cache, Zod `PurposeTags` (shape defined in phase 3) |
| `parsed_hash` | text | yes | — | **phase 3**: sha256 of the normalized `{text, guided, constraints}` the tags were parsed from |
| `parsed_at` | timestamptz | yes | — | **phase 3** |
| `created_at`, `updated_at` | timestamptz | no | `now()` | |

Index: `(owner_id, updated_at desc)`. Standard owner policies.
The three `parsed_*` columns are created now (nullable, unused) so phase 3 needs no migration on this table. Rule for phase 3: tags are valid only while `parsed_hash` equals the hash of the current content; otherwise re-parse lazily (on next generation), never on every edit. The browser must not write `parsed_*`: grant `update` on `(name, text, guided, constraints)` only; the server writes `parsed_*` with the secret key.

### 2.6 `app_events` (logging, created now)
Errors and key events for the admin page. Written **only by server code** with the secret key (`src/lib/server/events.ts`); never from the browser.

| Column | Type | Null | Default | Constraint / note |
|---|---|---|---|---|
| `id` | bigint identity | no | — | PK |
| `created_at` | timestamptz | no | `now()` | |
| `level` | text | no | `'info'` | `check (level in ('info','warn','error'))` |
| `event` | text | no | — | dotted name, `check (event ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$')`, e.g. `auth.signup`, `auth.signup_rejected`, `group.created`, `purpose.created`, `error.route`, `backup.completed` |
| `user_id` | uuid | yes | — | `references auth.users(id) on delete set null` |
| `route` | text | yes | — | e.g. `/api/health` |
| `request_id` | text | yes | — | Vercel request id, to match Sentry/Vercel logs |
| `props` | jsonb | no | `'{}'` | **metadata only**: ids, counts, durations, error codes/class names. Never names, notes, purpose text or emails |

Indexes: `(created_at desc)`, `(event, created_at desc)`, partial `(created_at desc) where level = 'error'`.
RLS: enabled; `select` for `private.is_admin()` only; no insert/update/delete policies (server writes bypass RLS with the secret key). `revoke all from anon, public; grant select to authenticated`.
Retention: 180 days, cleanup job in phase 6.

### 2.7 Logging tables deferred
| Table | Create in | Why not now |
|---|---|---|
| `api_cache`, `api_calls` | phase 2 (with the first integration client) | no external API is called in phase 1; the key/params shape is known only once clients exist |
| `ai_usage` | phase 3 | no LLM call before the generation pipeline |
Migrations are forward-only, so an unused table designed today would likely need a corrective migration later.

---

## 3. Invite / allowlist mechanism

1. Supabase Auth settings: **email provider on, "Allow new users to sign up" on** (needed so magic link can create the user), **"Confirm email" on**.
2. **Before User Created auth hook** → Postgres function `public.hook_before_user_created(event jsonb) returns jsonb` (`security definer`, `search_path = ''`):
   - `email := lower(event->'user'->>'email')`
   - if `exists (select 1 from public.signup_allowlist where email = ...)` → return `'{}'::jsonb` (allow)
   - else return `jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'signup_not_allowed'))`
   - `revoke execute ... from public, anon, authenticated; grant execute ... to supabase_auth_admin;`
   - Enabled in Dashboard → Authentication → Hooks (and `supabase/config.toml` `[auth.hook.before_user_created]` for local).
3. The same hook covers Google sign-in later: provider-independent.
4. UI: after "send link" the page always shows the same neutral message ("If this address is invited, a link is on its way"), also on a 403, so it does not reveal who is invited. Existing users always get a link.
5. Admin manages the list (phase 1: SQL/dashboard; phase 6: admin page). Pending invites = `used_at is null`.

Second layer (implemented, fail-closed): `private.handle_new_user()` raises `signup_not_allowed` when no allowlist row matches the new user's email (aborts the insert into `auth.users`). Signup therefore stays invite-only even if the hook is not enabled in the Dashboard, and for every creation path (Dashboard "Add user", admin API, password signup). Allowlist lookups use `email operator(extensions.=) lower(x)::extensions.citext` so the unique index is used.

Account deletion also deletes the user's allowlist row: a deleted user needs a new invite.

## 4. Profile creation trigger

```sql
create function private.handle_new_user() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare v_locale text := new.raw_user_meta_data->>'locale';
begin
  insert into public.profiles (id, locale, display_name)
  values (new.id,
          case when v_locale in ('de','en') then v_locale else 'de' end,
          left(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'), 80));
  update public.signup_allowlist set used_at = now() where email = lower(new.email) and used_at is null;
  insert into public.app_events (event, user_id) values ('auth.signup', new.id);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();
```
The client passes the current UI locale as `options.data.locale` in `signInWithOtp`, so the first email and profile use the right language. The `('de','en')` list in the trigger must be extended together with `routing.locales`.

## 5. Auth flow (magic link now, Google later)

- `@supabase/ssr` with cookies; one middleware that runs `next-intl` and refreshes the Supabase session. Server code checks the user with `supabase.auth.getClaims()` (verifies the JWT locally when asymmetric JWT signing keys are enabled; enable them in the dashboard) or `getUser()`.
- Magic-link email template uses the **token-hash** link, not the PKCE code link: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/{locale}`. The route handler calls `verifyOtp({ type: 'email', token_hash })`. Reason: the link then works when opened in a different browser or device than the one that requested it (typical for family members opening mail on the phone). The same email also shows the 6-digit `{{ .Token }}` as a fallback code (useful for the installed PWA).
- Redirect URLs allowed in Supabase: production URL, `http://localhost:3000/**`, Vercel preview pattern `https://*-<team>.vercel.app/**`.
- Custom SMTP is required for real users (Supabase's built-in mailer only sends to team members and is heavily rate-limited). See open question 1.
- Google later needs: OAuth client in Google Cloud (consent screen, client id/secret entered in Supabase), authorized redirect `https://<project>.supabase.co/auth/v1/callback`, a `/auth/callback` route that exchanges the code (`exchangeCodeForSession`), and a "Continue with Google" button. Allowlist hook and profile trigger need no change; `display_name` is filled from `full_name`. Supabase links identities with the same verified email automatically.

### Keys
| Key | Where | Used for |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`) | browser + server | every request **on behalf of a user** (role `anon` until signed in, then `authenticated`); RLS applies |
| `SUPABASE_SECRET_KEY` (`sb_secret_…`) | server only, `src/lib/server/supabase-admin.ts` with `import 'server-only'` | writing `app_events`, `parsed_*`, later `api_cache`/`ai_usage`, account deletion, admin aggregates. **Never** used to read user content for a user request |

Both keys are not JWTs; pass them as the `supabaseKey` to `createClient`/`createServerClient` as usual. The secret key is rejected by Supabase if sent from a browser, which is an extra guard.

## 6. Health check

```sql
create function public.health_check() returns jsonb
  language sql stable security invoker set search_path = ''
as $$ select jsonb_build_object('ok', true, 'db_time', now()) $$;
revoke execute on function public.health_check() from public;
grant execute on function public.health_check() to anon, authenticated;
```
- Reads no table, so it cannot expose user data, needs no `security definer`, and works with the publishable key.
- `/api/health` calls `supabase.rpc('health_check')` with the publishable key and a 3 s timeout; `checks.db = { ok, latencyMs }`. Overall status `degraded` if it fails.
- The call goes through the Data API into Postgres, so the 5-minute uptime ping counts as project activity and keeps Supabase Free from pausing.

## 7. Airports for home-airport autocomplete

- **Source:** OurAirports `airports.csv` (public domain, https://ourairports.com/data/). Filter: `scheduled_service = yes` and a 3-letter `iata_code` (all airport types, so small regional airports with scheduled flights are included), de-duplicated by IATA. 4,134 rows, about 283 KB (2026-10-27).
- **Build:** `scripts/airports/build.mjs` (`npm run airports:build`) downloads the CSV, filters, and writes `src/data/airports.json` as compact tuples `[iata, name, city, countryIso2, lat, lon]` plus `{ source, fetchedAt }`. The JSON is committed (deterministic, reviewable diff); rerun manually about once a year.
- **Use:** `src/lib/integrations/airports.ts` loads it once (server only: import it from server code or call the route, never from client components), exposes `searchAirports(q, limit = 8)` (exact IATA match first, then prefix on city/name, accent-insensitive) and `isKnownIata(code)`. Route `GET /api/airports?q=fra` returns up to 8 results, `Cache-Control: public, max-age=86400`. Zod for `home_airports` refines with `isKnownIata`.
- **Not a DB table:** nothing joins on it, it would bloat backups and migrations, and an in-memory search avoids a DB round trip. Lat/lon are included for later distance hints (phase 4).
- Country names are localized in the UI with `Intl.DisplayNames(locale, { type: 'region' })`; airport/city names stay as in the dataset.

---

## 8. TypeScript / Zod sketches
`src/lib/schemas/{profile,group,purpose}.ts`. DB uses snake_case; map to camelCase at the data-access layer.

```ts
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);       // plus a refine for a real calendar date
const Iata = z.string().regex(/^[A-Z]{3}$/).refine(isKnownIata);

export const Profile = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "admin"]),
  displayName: z.string().max(80).nullable(),
  locale: z.enum(routing.locales),
  homeAirports: z.array(Iata).max(5),          // ordered, unique (refine)
  birthdate: IsoDate.nullable(),
});
export const ProfileUpdate = Profile.pick({ displayName: true, locale: true, homeAirports: true, birthdate: true }).partial();

export const AgeMode = z.enum(["exact", "approx", "relativeToMe"]);

export const EntryTraits = z.object({
  mobility: z.enum(["none", "limited", "wheelchair", "stroller"]).optional(),
  diet: z.array(z.string().max(40)).max(10).optional(),      // free tags: "vegetarisch", "glutenfrei"
  golfHandicap: z.number().min(-10).max(54).optional(),
  needsNap: z.boolean().optional(),
}).strict();

const EntryBase = {
  id: z.string().uuid().optional(),
  position: z.number().int().min(0),
  label: z.string().max(60).optional(),
  notes: z.string().max(1000).optional(),
  traits: EntryTraits.default({}),
};
const StatedAge = z.discriminatedUnion("ageMode", [
  z.object({ ageMode: z.literal("exact"), age: z.number().int().min(0).max(120) }),
  z.object({ ageMode: z.literal("approx"), age: z.number().int().min(0).max(120) }),
  z.object({ ageMode: z.literal("relativeToMe") }),
]);                                                   // ageAsOf is set by the server, not the form

export const CompositionEntry = z.object({
  ...EntryBase,
  kind: z.literal("composition"),
  count: z.number().int().min(1).max(50),
  age: StatedAge.optional(),                          // "2 adults" without any age is valid
});
export const MemberEntry = z.object({
  ...EntryBase,
  kind: z.literal("member"),
  isSelf: z.boolean().default(false),
  name: z.string().min(1).max(80).optional(),         // required unless isSelf (refine)
  birthdate: IsoDate.optional(),                      // if set, `age` must be absent (refine)
  age: StatedAge.optional(),
});
export const GroupEntry = z.discriminatedUnion("kind", [CompositionEntry, MemberEntry]);

export const TravelGroup = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(80),
  notes: z.string().max(2000).optional(),
  entries: z.array(GroupEntry).max(30).default([]),
});

export const PurposeGuided = z.object({
  v: z.literal(1),                                    // bump when the wizard changes shape
  pace: z.enum(["relaxed", "balanced", "packed"]).optional(),
  interests: z.array(z.string().max(40)).max(20).optional(),   // keys from a static list ("golf", "christmas_markets") or custom text
  budget: z.enum(["low", "mid", "high", "luxury"]).optional(),
  accommodation: z.array(z.enum(["hotel", "apartment", "cruise_cabin", "camping", "any"])).optional(),
  rooms: z.enum(["shared", "single_rooms"]).optional(),
}).partial({ v: true });

export const TripPurpose = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(80),
  text: z.string().max(4000).optional(),
  guided: PurposeGuided.default({}),
  constraints: z.array(z.string().min(1).max(200)).max(30).default([]),
});
```

Fixture mapping check:
- Danube: group = `[{kind:'composition', count:2, age:{ageMode:'relativeToMe'}, label:'Eltern'}, {kind:'composition', count:1, age:{ageMode:'approx', age:1}, label:'Kleinkind', traits:{needsNap:true}}]` + group `notes`; purpose `text` + `constraints`.
- Golf: one composition entry `{count:2, relativeToMe, label:'Golfer'}`; purpose `text`, 8 `constraints`, `guided.rooms = 'single_rooms'` (optional duplicate of the constraint). Home airport `FRA` on the profile.
- Mixed example "me + my son + 3 friends ~45": `[{member, isSelf}, {member, name:'Ben', birthdate}, {composition, count:3, approx 45, label:'Freunde'}]`.

How later phases fit: `trips` (phase 2) gets nullable `group_id`/`purpose_id` FKs (`on delete set null`), and each generation stores a **snapshot** of the resolved group (ages for the travel dates) and purpose inside `plan_versions`, so editing a group never changes old plans.

---

## 9. Migration files (in order)
`supabase/migrations/`, timestamps assigned at creation:

1. `…_base.sql`: `create schema private`; `create extension if not exists citext with schema extensions`; `private.set_updated_at()`.
2. `…_profiles.sql`: `profiles`, column grants, RLS, `private.is_admin()`, `updated_at` trigger.
3. `…_signup_allowlist.sql`: table, admin RLS, `public.hook_before_user_created()` with grants to `supabase_auth_admin`.
4. `…_app_events.sql`: table, indexes, admin-read RLS.
5. `…_handle_new_user.sql`: `private.handle_new_user()` + trigger on `auth.users` (needs 2–4).
6. `…_travel_groups.sql`: `travel_groups`, `group_entries`, constraints, indexes, RLS, triggers.
7. `…_trip_purposes.sql`: table, column grants, RLS, trigger.
8. `…_health_check.sql`: `public.health_check()`.

Not a migration: Auth settings (hook, email template, SMTP, redirect URLs, JWT signing keys) go into `docs/hosting-setup.md` and `supabase/config.toml` for local.

Tests (`qa-reviewer`): RLS isolation (user B cannot select/update/delete A's groups, entries, purposes, profile); user cannot update own `role` or `parsed_*`; entry with a foreign `group_id` is rejected; non-allowlisted email cannot sign up; non-admin cannot read `app_events`/`signup_allowlist`; `anon` can call only `health_check`.

---

## 10. Open questions for Alex (with recommended default)

**Decided 2026-10-27:**
- Questions 2–9: all defaults accepted.
- Question 1 (SMTP) is deferred. Until a custom sender is set up, only Supabase team members (Alex) can receive magic links. Configuring SMTP (Resend with own domain, or Brevo) is a **prerequisite before inviting anyone else** and is tracked as a phase 1 to-do in `docs/hosting-setup.md`.

1. **Email sender (SMTP) for magic links.** Supabase's built-in mailer won't reach family and friends. *Default:* Resend free tier (3,000 mails/month) with a sender on a domain you own; without your own domain, Brevo free (300/day) with a verified single sender address.
2. **Invite mechanism.** *Default:* allowlist table + Before User Created hook (section 3). Alternative: invite emails sent by the admin via `inviteUserByEmail`, which works without the hook but needs an admin UI earlier.
3. **Default locale for new users.** *Default:* the UI locale at signup (passed in metadata), falling back to `de`.
4. **Maximum home airports.** *Default:* 5, ordered.
5. **Structured traits on group entries** (mobility, diet, golf handicap, needs nap) in addition to free-text notes. *Default:* yes, all optional, as in `EntryTraits`; the form shows them collapsed under "more details".
6. **Stated ages "age up" over time** (an "approx 45" entered today is ~47 for a trip in two years). *Default:* yes, via `age_as_of`; the UI shows "~47 at travel time".
7. **Guided purpose options** (pace, budget, accommodation, interests list). *Default:* the enums in `PurposeGuided`; the interest list is a static set of ~20 keys plus custom text. Please confirm or edit the lists before `frontend-dev` builds the wizard.
8. **Account deletion in phase 1.** (Known and accepted: a deleted user's JWT stays valid until `jwt_expiry`, 1 hour; reads then find no data and server actions fail on missing rows. Deleting the allowlist row means re-registration needs a new invite.) *Default:* yes, a "delete my account" button in settings (server route with the secret key deletes the auth user; everything cascades). It is cheap now and needed for GDPR anyway.
9. **`app_events` retention.** *Default:* 180 days.
