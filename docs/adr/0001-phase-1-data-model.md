# ADR 0001: Phase 1 data model, auth and supporting data

Status: proposed · Date: 2026-10-27 · Spec: `docs/specs/phase-1-data-model.md`

## Context
Phase 1 adds accounts and reusable travel context. All context is optional and mixable (ground rule 3), ages are never stored (rule 4), and users only see their own data (rule 6). The app is invite-only, runs on Supabase Free with the new `sb_publishable_…` / `sb_secret_…` keys, and must stay cheap in tokens and API calls.

## Decisions

1. **One `group_entries` table with a `kind` discriminator (`composition | member`)**, not two tables.
   A named member is a composition entry with `count = 1` plus a name and optional birthdate; both share label, stated age, notes and traits. One table gives one `position` order across mixed entries ("me + my son + 3 friends ~45"), one RLS policy set and one query per group. Kind-specific rules are `check` constraints, mirrored by a Zod discriminated union.
   *Consequence:* some columns are null for one kind; the checks must be kept in sync with Zod.

2. **Stated ages are stored with the date they were stated (`age`, `age_as_of`); birthdates are stored as dates.** The age for a trip is computed in code (`ageOn` for birthdates, `age + years since age_as_of` for stated ages). `relativeToMe` and the "self" member (`is_self`) read `profiles.birthdate`.
   *Consequence:* a reused group stays correct years later; no age for a real person is ever persisted.

3. **`owner_id` on child rows plus a composite FK `(group_id, owner_id) → travel_groups(id, owner_id)`.** RLS stays the plain `owner_id = auth.uid()` everywhere and an entry can never be attached to someone else's group.

4. **Purposes: free `text`, a versioned `guided` jsonb (Zod `PurposeGuided`) and `constraints text[]`.** The wizard will change and the DB never filters on these fields, so jsonb avoids migrations; constraints are a first-class ordered list because the generator treats them as hard rules. `parsed_tags`, `parsed_hash`, `parsed_at` are created now (nullable) for the phase 3 Haiku cache; tags are valid only while the hash matches the content.

5. **Invite-only via `signup_allowlist` + Supabase "Before User Created" auth hook.** Provider-independent (works unchanged for Google), rejects before a user row exists, and lets the UI answer neutrally. Fallback: raise in the signup trigger. A trigger on `auth.users` creates the profile, marks the invite used and logs `auth.signup`.

6. **Roles in `profiles.role`; self-promotion blocked by column-level `update` grants.** Admins get no policies on content tables; aggregates come from `security definer` functions in phase 6. Helpers (`is_admin`, triggers) live in a non-exposed `private` schema.

7. **Key usage:** the publishable key for everything done on behalf of a user (RLS applies); the secret key only in `src/lib/server/` for logs, caches, `parsed_*` and account deletion, never to read user content for a request.

8. **Logging:** `app_events` now (signups and errors happen in phase 1); `api_cache` + `api_calls` in phase 2 and `ai_usage` in phase 3, when their writers exist. Migrations are forward-only, so tables are not designed ahead of their first use.

9. **Health check:** `public.health_check()`, a `security invoker` function that reads no table, callable with the publishable key. It proves the Data API and Postgres are up and doubles as the Supabase keep-alive, without exposing any data.

10. **Airports:** static JSON built from OurAirports (public domain), committed to the repo and searched in memory by a route handler. Deterministic, free, no DB table, no LLM.

11. **Magic links use the token-hash template (`verifyOtp`)**, not the PKCE code link, so a link opened in another browser or device still works; a 6-digit code is shown as a fallback.

## Consequences
- Phase 2 `trips` reference groups/purposes with nullable FKs and snapshot the resolved context into `plan_versions`.
- Some setup is dashboard configuration, not migrations (auth hook, email template, SMTP, redirect URLs); it must be documented in `docs/hosting-setup.md` and mirrored in `supabase/config.toml`.
- Allowed locales appear in Zod (`routing.locales`) and in the signup trigger; adding a language touches both.
