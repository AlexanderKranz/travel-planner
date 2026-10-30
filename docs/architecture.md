# Travel Planner — Architecture & Plan

## Context
Alex plans many different kinds of trips:
- family trips (e.g. an Advent Danube cruise with a toddler)
- golf trips with friends (e.g. Costa del Sol: 5 days, a round every day, flat courses, at most 3 h flight from FRA)
- work trips to see a city's highlights

Planning these with an AI assistant means typing the same context every time. Family and friends have the same problem, and not all of them are comfortable with AI assistants.

The app lets each user save reusable context: optional travel groups, trip purposes and home airports. From that it builds a travel plan the user can iterate on, with destination info, weather, verified flights and a daily itinerary. Plans are saved per user, can be shared by a link that always shows the latest version, and can be exported as a PDF.

**Design constraint: use as few tokens as possible.** Anything that can be done by an API or plain code is done that way. The LLM is used only where judgment or natural language is truly needed.

The project folder `/Users/alex/dev/travel-planner` started empty. Two real plans (local only, not in this repo) in `/Users/alex/dev/urlaubsplanung/` are reference material:
- the Danube cruise plan: family, port times, toddler naps, early darkness, "best day" marker
- the Costa del Sol golf plan + requirements notes: 2 friends, hard constraints, options with booked/open/rejected status, cost per person, open items

## Decisions (confirmed)
| Topic | Choice |
|---|---|
| Hosting | Managed cloud: **Vercel** (app) + **Supabase** (Postgres, Auth, RLS). Details in the hosting guide below. |
| Stack | **Next.js (App Router) + TypeScript**, Tailwind + shadcn/ui, responsive and installable as a PWA |
| Languages | **de + en** using `next-intl`. Strings live in `messages/<locale>.json`, so a new language is just a new file. The structured plan stores only keys and data; the LLM writes prose in the user's language. |
| Flights | **AeroDataBox** (low-cost schedule API): verified direct routes per month. No prices; deep links to Google Flights / Skyscanner. |
| AI | Claude API only where needed. Details in the token strategy below. |

## Travel context model (all of it optional)
A trip can be created with **no group and no purpose**: destination and length are enough. Context can be added at three levels of detail and mixed freely:

1. **Quick description:** structured shorthand, e.g. "5 adults, around my age", "2 adults + 1 toddler". Stored as composition entries: `{count, ageMode: exact|approx|relativeToMe, age?, label?}`.
2. **Named members** (optional per person): name, birthdate → age is computed for the travel date, optional notes (mobility, diet, handicap, "needs nap").
3. **Free-text notes** on the group, for anything the structure doesn't cover.

A group can mix levels. Example: "me (birthdate) + my son (birthdate) + 3 friends ~45".

**Trip purposes** are reusable and work the same way: a free-text field, optional guided answers (pace, interests, budget, accommodation, must-haves / hard constraints such as "max 3 h flight", "flat courses", "single rooms"), or both.

## Core principle: facts come from APIs, the LLM only composes
Flights, weather, daylight, distances and destination facts come from APIs and are fetched first. Claude receives them as compact input and must never invent routes. The UI shows verified data in separate blocks labelled with source and check date.

## Token strategy: deterministic first
| Task | Approach | LLM? |
|---|---|---|
| Ages at travel date, trip dates, day skeleton | code | no |
| Geocoding, destination autocomplete | Open-Meteo Geocoding (free) | no |
| Weather: monthly climate or 12-month average | Open-Meteo Climate/Historical API, cached | no |
| Daylight (sunrise/sunset, "dark from 16:15") | `suncalc` library | no |
| Direct flights per month | AeroDataBox airport schedules, cached per airport and month | no |
| Country facts (currency, language, plugs, time zone) | REST Countries + static dataset | no |
| Points of interest / golf courses / candidate activities | OpenStreetMap (Overpass), Wikivoyage/Wikipedia extracts, cached | no |
| Driving times between hotel and places | OpenRouteService (free tier) | no |
| Guided wizard for purpose and refinements | static form flows | no |
| Rendering the plan page, share page and PDF | templates from structured JSON | no |
| Turning free-text purpose into structured tags | **Haiku**, once per purpose, result cached | small |
| Composing the daily itinerary from candidates, facts and constraints | **Sonnet**, one call, compact JSON in, JSON out | yes |
| Iterating ("more rest", "swap day 3") | **Patch only the affected days** (JSON patch), not the whole plan | small |

Further savings:
- prompt caching for the system prompt and schema
- hash-based cache of identical generation inputs
- per-user daily token budget, with usage logged in `ai_usage`

## Plan structure (based on the example trips)
The structured plan JSON contains:
- header: title, dates, group summary, key stats
- destination block: facts, weather, daylight
- flights block: verified routes + booking links
- days: date, location, time window (e.g. port call 07:00–12:00), activities, notes or warnings, "highlight" flag
- **items with status and cost:** hotels, courses, rental car, flights, each with `option | booked | rejected` + price per person → cost summary
- open items / to-dos

The plan view, share page and PDF are rendered from this structure. The visual style draws on the two HTML examples (day cards, badges, cost table).

## Architecture
- **Auth:** Supabase Auth (magic link + Google), invite-only or allowlisted at first.
- **Isolation:** every table has `owner_id`, and RLS enforces `owner_id = auth.uid()`. Share pages are rendered server-side by an unguessable token, read-only, and always show the latest version. Links can be revoked.
- **Tables:**
  - `profiles` (language, home airports)
  - `travel_groups`, `group_entries` (composition and/or named member)
  - `trip_purposes`
  - `trips`
  - `plan_versions` (JSON + the feedback that produced each version)
  - `share_links`
  - `api_cache`
  - `ai_usage` (user, model, input/output tokens, estimated cost, purpose: generate / patch / parse)
  - `api_calls` (provider, cache hit/miss, status, latency): feeds monitoring and quota tracking
  - `app_events` (errors and key events: signup, plan generated, share opened, PDF exported)
- **Roles:** `profiles.role` = `user | admin`. Admin routes check the role on the server, and RLS adds admin-only policies for the aggregate views.
- **PDF:** `@react-pdf/renderer` in a server route, built from the same JSON.
- **Region:** EU (Supabase Frankfurt, Vercel `fra1`) for GDPR and low latency.

## Admin area & monitoring
**Admin page `/[locale]/admin`**, visible only to `role = admin`. Privacy rule: admins see **aggregates and metadata, never the content** of other users' groups, purposes or plans.

| Section | Shows | Source |
|---|---|---|
| Users | total, active last 7/30 days, new signups, pending invites; manage invites/allowlist | `auth.users`, `profiles` |
| Usage | trips and plan versions per day/week, iterations per plan, shares opened, PDFs exported | `trips`, `plan_versions`, `app_events` |
| AI cost | tokens and estimated € per day, model and user; budget progress against the monthly cap; top consumers | `ai_usage` |
| External APIs | calls per provider, cache hit rate, error rate, quota used this month (AeroDataBox, ORS) | `api_calls` |
| Health | status of DB, Anthropic, AeroDataBox and Open-Meteo (from `/api/health`), last backup run, last deploy | health route, backup log |
| Errors | latest errors with route and time | `app_events` |

Charts are rendered from SQL views (`admin_daily_usage`, `admin_ai_cost`, `admin_api_stats`), so no LLM is involved.

**Monitoring and alerting (free tiers):**
- `/api/health`: checks the DB connection and the reachability of the key providers. Pinged every 5 min by **UptimeRobot** or **Better Stack** (free), which emails you when it's down. The same ping keeps Supabase Free from pausing.
- **Sentry** (free developer plan): error tracking for client and server, with alerts by email.
- **Vercel**: built-in runtime logs, deploy history, Web Analytics (free on Hobby, limited).
- **Budget alerts:** a daily Vercel Cron job checks `ai_usage` and `api_calls` against thresholds (e.g. 80 % of the monthly AI budget or AeroDataBox quota) and emails the admin. Also set a hard spend limit in the Anthropic console.

## Deployment
- **Environments:**
  - **Production** = branch `main`
  - **Preview** = every pull request, with its own URL
  - **Local** = `npm run dev` against a separate Supabase dev project (or the local Supabase CLI)
- **App:** Vercel Git integration. A push or merge to `main` deploys automatically. **Rollback** = "Instant Rollback" to the previous deployment in the Vercel dashboard (one click).
- **Database migrations:** SQL files in `supabase/migrations/`. GitHub Action `deploy-db.yml` runs `supabase db push` against production on every push to `main` that changes `supabase/migrations/**`. Migrations are forward-only. A bad migration is fixed by a new migration, after restoring from backup if needed.
- **CI gate (`ci.yml`):** lint, typecheck, unit tests and build on every PR. Branch protection on `main` requires CI to pass.
- **Secrets:** Vercel env vars (separate values for Production and Preview) and GitHub Actions secrets (`SUPABASE_DB_URL`, `BACKUP_PASSPHRASE`; the deploy uses `supabase db push --db-url`, so no Supabase access token). Nothing secret lives in the repo.
- **Runbook:** `docs/runbook.md` covers deploy, rollback, rotating a key, restoring a backup, and what to do when an alert fires.

## Backups & restore
Supabase Free has **no downloadable automated backups** (Pro includes daily backups with 7-day retention). The app therefore makes its own backups from the start:

1. **Nightly GitHub Action `backup.yml`** (free):
   - `pg_dump` of the production database (schema + data, including `auth`)
   - compress and encrypt with `gpg` (passphrase in GitHub secrets)
   - upload as a workflow artifact with 30-day retention
   - write the result to `app_events` so the admin page shows "last backup"
2. **Off-site copy to your DiskStation:** a script `scripts/backup/pull-to-nas.sh` (fits next to your `diskstation-scripts`) downloads the latest encrypted artifact through the GitHub API once a day via DSM Task Scheduler. It keeps a longer history (e.g. 30 daily + 12 monthly), and Hyper Backup can include it in your existing NAS backup.
3. **Restore:** `scripts/backup/restore.sh <dump>` decrypts and restores into a target database (a fresh Supabase project or local Postgres). Documented in the runbook.
4. **Restore test:** a quarterly manual (or scheduled) restore into a scratch Supabase project, with row counts checked against production.

Files (PDFs) are generated on demand, so nothing needs backing up beyond the database.

## Hosting guide (you have only hosted static sites so far)
A static site is just files on a web server. This app has three parts, each hosted by a specialised provider:

1. **App hosting:** runs the Next.js pages and server functions. Every push to GitHub deploys automatically, and every branch gets its own preview URL.
2. **Database + login:** Postgres stores all user data. Auth handles signup and login.
3. **Secrets:** API keys (Anthropic, AeroDataBox) are stored as environment variables on the host and never shipped to the browser.

| Need | Recommended (free start) | Low-cost alternatives | Watch out for |
|---|---|---|---|
| App hosting | **Vercel Hobby**: free, automatic GitHub deploys | Cloudflare Pages/Workers (free, very generous), Netlify (free) | Vercel Hobby is for non-commercial use; fine for family and friends. Upgrade is Pro, about $20/month. |
| DB + Auth | **Supabase Free**: Postgres, Auth and RLS in one place | Neon Postgres (free) + Auth.js; Cloudflare D1 | Free projects **pause after ~1 week without activity**. Fix with a small scheduled ping (Vercel Cron) or Pro at about $25/month. |
| AI | Anthropic API, pay per use | — | The main running cost. Kept low by the token strategy, plus a monthly spend limit set in the Anthropic console. |
| Flights | AeroDataBox via RapidAPI (free/basic tier) | AeroDataBox direct plans | Monthly request quota, so results are cached per airport and month |
| Weather / maps | Open-Meteo, OSM, OpenRouteService | — | Free, with fair-use rate limits, so results are cached |
| Domain (optional) | `*.vercel.app` subdomain for free | own domain ~10–15 €/year | — |

**Expected running cost at family/friends scale: about €0 hosting + a few € per month for AI.** The exact free-tier limits will be checked during phase 0 setup.

In phase 0 I'll walk you step by step through connecting your existing GitHub repo to Vercel, creating the Supabase project, the API keys and the environment variables.

## Phases
0. **Setup:**
   - Repo moved into `travel-planner/` (done 2026-10-27)
   - Scaffold, `CLAUDE.md`, `.claude/agents/`, guided account setup, CI (lint, typecheck, test), first deploy of a "hello" page
   - Deployment pipeline: Vercel Git integration, `deploy-db.yml`, branch protection, `/api/health` + uptime monitor
1. **Accounts & context:** auth + roles, optional groups (quick composition + named members + notes), purposes (free text + guided), home airports, i18n de/en. **Demo login** (shared demo account, button on the login page, server-side password, example data + reset script, no account deletion or email change, off switch `DEMO_ENABLED`). **Backups go live** (`backup.yml`, NAS pull script, restore script) as soon as there is real data. Sentry is set up.
   *In parallel:* flight-data spike that checks AeroDataBox against real routes (FRA→AGP in March, PAS-area/Danube airports).
2. **Trip & facts:** trip form, geocoding, weather, daylight, country facts, POI/course candidates, caching
3. **AI plan:** generation pipeline, plan view, guided and free-text iteration via day patches, version history, token budget
4. **Flights:** verified direct-routes panel + booking deep links
5. **Items, costs, sharing, export:** item status and cost summary, share links, PDF
6. **Admin & hardening:** admin page (users, usage, AI cost, API stats, health, errors), budget alert cron, rate limits, error states, E2E tests, accessibility and mobile polish, invite flow, first restore test, `docs/runbook.md`.
   Usage logging (`ai_usage`, `api_calls`, `app_events`) is built from phase 2/3 onwards, so the admin page has data when it arrives.

### Open items / backlog
- **Weekend check** (Alex, 2026-10-30):
  - **Nightly backup with upload-artifact v7** (PR #39): Actions → "Nightly database backup" → latest run → a `db-backup-…` artifact is listed. Or ask Claude to "check the backup".
- **Share plans, groups and purposes between users** (Alex, 2026-10-30): today everything is owner-only (ground rule 6) and plans are shared read-only by link. Needs a spec/ADR first: what is shared (a copy vs. live access), read vs. edit rights, how to invite (by email of an existing user), what the other user sees of birthdates and notes, and RLS policies for the shared rows (an access table instead of `owner_id = auth.uid()` alone). A "copy to my account" for groups and purposes is the simple first step.
- **Pictures of the destination** (Alex, 2026-10-30): one or a few photos in the trip header and share page. Facts-from-APIs rule applies: take them from Wikimedia Commons / the Wikipedia page image of the destination (free, keyed by the same article as "Über das Reiseziel"), cache in `api_cache`, show author and licence under each picture. No AI-generated images. Check the PDF size if they go into the export.
- **Find destinations by trip purpose** (Alex, 2026-10-28): instead of starting from a destination, a user picks a purpose (e.g. "golf, flat courses, max 3 h flight from FRA, March") and gets suggested destinations. Deterministic first: filter candidates by verified facts (direct flights from home airports, flight time, climate in the chosen months, matching OSM places such as golf courses); the LLM may only rank or explain the shortlist, never invent places or routes. Open design question before a spec: flight data cost (scanning a month of departures per airport is about 120 AeroDataBox units), so it needs a rarely refreshed route list per airport or another source.
- **Optional email + password login** (Alex, 2026-10-29): today login is the email link / 6-digit code only; each device stays logged in for months. Add an optional password (set under Einstellungen), "Mit Passwort anmelden" on the login page next to the link, "Passwort vergessen?" via the Reset Password template (Atlas style, like the other templates), minimum length and Supabase leaked-password protection, existing auth rate limits. The email link stays the default; invite-only unchanged. Google login and passkeys were considered and deferred.
- **DiskStation backup pull** (optional, needs Alex): `scripts/backup/pull-to-nas.sh`, see `docs/runbook.md` section 4.
- **Bug reports and enhancement requests from users** (Alex, 2026-10-30): a "Feedback" form in the app (type bug/idea, text, optional screenshot, page URL and app version added automatically). Automation idea: the server route creates a GitHub issue (token server-side, fine-grained, issues only), labelled `bug` or `enhancement`. Alex triages and adds a label such as `claude`; that label starts the Claude Code GitHub Action (`anthropics/claude-code-action`), which implements the change on a branch and opens a PR; CI, CodeRabbit and CodeQL run as usual and Alex merges. Guard rails: the repo is public, so issues must not contain personal data (strip email, ask users not to paste trip details) or the report is stored in Supabase and Alex promotes it to an issue; user text is untrusted input to an agent (prompt injection), so the agent only starts after Alex's label, has no access to production secrets, and never merges. Needs a spec first.
- **Rework "Über das Reiseziel"** (Alex, 2026-10-30): details to collect with Alex first (content, length, sources, placement on phone and desktop).

Done or closed:
- ~~Time difference to home~~ done 2026-10-31: tile "Time difference" in "At a glance" on the owner's trip page (`src/lib/facts/time-difference.ts`, Intl only, handles half hours and daylight saving changes during the trip). Optional home place in Einstellungen (`profiles.home_location`, `home_timezone`, picked via the destination search), default Europe/Berlin shown as Germany. Not in the share page, PDF or LLM input. Open: plan strip / PDF, suggesting the home from the home airports.
- ~~Lighter CI for docs-only changes~~ done 2026-10-31: job `changes` in `ci.yml` sets `docs_only`; build, db-test and e2e are skipped for docs-only PRs (skipped jobs count as passing for required checks). Vercel skips docs-only preview builds via `ignoreCommand`. See `docs/runbook.md` section 14.
- ~~Disable users~~ done 2026-10-31 (Alex, 2026-10-30; delete added as a third admin action): admin page -> Users: Disable / Enable / Delete. Disable sets `profiles.disabled_at` (not user-writable) plus a Supabase Auth ban; `getUserSession()` treats a disabled user as signed out at once, and their share links answer 404. Details and limits: `docs/runbook.md` section 11.
- ~~GitHub code security~~ done 2026-10-30: Dependabot alerts and security updates, secret scanning and push protection on (checked via the API); CodeQL advanced setup.
- ~~Travel group editor feels clunky~~ closed 2026-10-29: free-text group descriptions (`docs/specs/group-text.md`) solved it for Alex.
- ~~Custom SMTP sender~~ done 2026-10-29: Brevo, sender `travel-planner@alexanderkranz.de`, Magic Link, Confirm signup and Invite templates in Atlas style.
- ~~Backup restore test~~ done 2026-10-29: workflow "Restore test", first run PASS (`db-backup-20261029T063555Z`).
- ~~Overall look of the site~~ done 2026-10-29: design direction Atlas for site and PDF.
- ~~"Getting started" guide~~ done 2026-10-29: `docs/specs/getting-started.md`.
- ~~Sentry alert emails land in spam~~ resolved 2026-10-29; budget alert rule set up.
- ~~Not yet tested on a phone~~ done 2026-10-30: Alex tested the app on a phone; findings went into PR #31.
- ~~Old macOS / browser~~ closed 2026-10-29: not an app issue.

## Proposed agent team (`.claude/agents/`)
I act as the orchestrator: I split the work, delegate it, and integrate and verify the results.

| Agent | Model | Responsibility | Tools |
|---|---|---|---|
| `architect` | opus | Data model, RLS, plan JSON schema, API contracts, ADRs in `docs/adr/`. Reviews structural changes. | Read, Grep, Glob, Write (docs only) |
| `backend-dev` | sonnet | Supabase migrations, RLS, route handlers, caching, rate limits, PDF route, usage logging, admin SQL views and role checks | Read, Edit, Write, Bash, Grep, Glob |
| `devops` | sonnet | GitHub Actions (CI, DB deploy, nightly backup), backup/restore and NAS scripts, health endpoint, Sentry, uptime and budget alerts, runbook | Read, Edit, Write, Bash, Grep, Glob, WebFetch |
| `frontend-dev` | sonnet | Pages and components, responsive/PWA, wizards, i18n messages, accessibility | Read, Edit, Write, Bash, Grep, Glob |
| `integrations-dev` | sonnet | Open-Meteo, AeroDataBox, OSM/Overpass, OpenRouteService, REST Countries: typed clients + caching. Owns the flight-data spike. | Read, Edit, Write, Bash, Grep, Glob, WebFetch, WebSearch |
| `ai-engineer` | opus | Minimal prompts, JSON schema, generation and patch iteration, Haiku/Sonnet routing, token budget, evals on the example trips | Read, Edit, Write, Bash, Grep, Glob |
| `qa-reviewer` | sonnet | Vitest, Playwright E2E (mobile + desktop), RLS isolation tests, reviews every change, watches for unnecessary LLM calls | Read, Write (tests only), Bash, Grep, Glob |

Shared rules go in **`CLAUDE.md`** so every agent starts with them:
- stack and conventions
- facts come from APIs
- deterministic first / token budget
- i18n only through message files
- optional context everywhere

## Files created in phase 0
- `CLAUDE.md`, `.claude/agents/*.md` (6 agents), `docs/architecture.md`, `docs/hosting-setup.md` (step-by-step guide)
- Next.js scaffold, `supabase/migrations/`, `messages/{de,en}.json`, `.env.example`
- `evals/fixtures/`: the Danube cruise and Costa del Sol trips turned into input fixtures (group, purpose, constraints) + the expected plan characteristics

## What Alex needs to provide
- GitHub repo: already exists (`AlexanderKranz/travel-planner`) ✅. Vercel will connect to it. Also needed: Vercel, Supabase, Anthropic and RapidAPI (AeroDataBox) accounts. Later: Sentry and UptimeRobot/Better Stack (both free). Phase 0 guides you through each.
- Optionally: a work-trip example to make a third eval fixture

## Verification
- **CI per phase:** lint, typecheck, Vitest (age calculation, composition parsing, API clients against recorded responses)
- **Playwright E2E** on mobile and desktop viewports:
  - trip with no group → plan
  - trip with a quick group ("2 adults ~45") → plan
  - trip with named members → plan
  - iterate → share → open the link logged out → export a PDF
- **RLS test:** user B cannot read user A's data
- **Admin:** a non-admin gets 404 on `/admin` and its data routes. The admin sees aggregates but no group, purpose or plan content of other users.
- **Deployment:** a PR gets a preview URL and green CI. Merging to `main` deploys the app and applies migrations. Instant Rollback is tested once.
- **Backups:** the nightly job produces an encrypted dump. The NAS script pulls it. A restore into a scratch project matches production row counts.
- **Monitoring:** stopping a provider key makes `/api/health` report degraded and the uptime monitor alert. An error thrown on purpose shows up in Sentry.
- **Flights:** verified routes for FRA→AGP in March include LH; no routes appear that aren't in the schedule
- **AI evals:** the two example trips must respect their hard constraints (daily golf with 36 holes on day 2 and airport-near courses on arrival/departure day; nap time and port windows for the cruise). Tokens per generation and iteration are logged and compared against a budget.
