# Hosting Setup — Step by Step

This guide sets up every outside service the Travel Planner uses, in order. Each step says what to copy and where it goes. Real keys go only into `.env.local` (on your Mac) and the Vercel/GitHub/Supabase settings, never into the repo.

> Free-tier limits and dashboard menu names change over time. If a screen looks different, look for the same concept nearby. Operations (deploy, rollback, backup, alerts) are in `docs/runbook.md`.

## How the pieces fit together
```
Browser (phone / desktop)
   │  https://travel-planner-eta-cyan.vercel.app
   ▼
Vercel (fra1) ── runs the Next.js app, deploys on every push to main, daily budget cron
   │
   ├──► Supabase (Frankfurt) ──── Postgres + login (Auth) + Row-Level Security
   │        └──► Brevo (SMTP) ─── login and invite emails from travel-planner@alexanderkranz.de
   ├──► Anthropic API ─────────── Claude: Haiku (tags, groups), Sonnet (itinerary)
   ├──► AeroDataBox (RapidAPI) ── verified flight schedules
   ├──► OpenRouteService ──────── driving times
   ├──► Open-Meteo ────────────── geocoding, climate (no key)
   ├──► Overpass / OpenStreetMap ─ places, golf courses (no key, 3 mirrors)
   ├──► Wikipedia / Wikivoyage ── destination summary (no key)
   └──► Sentry (EU) ───────────── error reports and budget alerts

GitHub ── code, CI, DB migrations deploy, nightly encrypted backup, restore test ──► DiskStation (optional copy)
UptimeRobot ── pings /api/health every 5 minutes
Strato ── DNS for alexanderkranz.de (email sender records)
```

## Provider overview

| Provider | Used for | Account / plan | Key or setting | Limits to watch |
|---|---|---|---|---|
| **GitHub** | Code, CI, migrations deploy, nightly backup, restore test | Free | Actions secrets `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE` | Backup artifacts expire after 30 days |
| **Vercel** | App hosting, previews, budget cron | Hobby (free) | All app env vars (see the table at the end) | Hobby is for non-commercial use; functions up to 300 s |
| **Supabase** | Database, Auth, RLS | Free, region Frankfurt | URL, publishable key, secret key; SMTP settings | Free projects pause after ~1 week idle (UptimeRobot prevents it) |
| **Brevo** | Sending login and invite emails (SMTP for Supabase) | Free (~300 mails/day) | SMTP key, stored **only in Supabase** | Supabase Auth rate limit set to ~30 emails/hour |
| **Strato** | DNS for `alexanderkranz.de` | Existing domain contract | Brevo TXT + DKIM records | Keep the existing DMARC record (`p=reject`) |
| **Anthropic** | Claude API | Pay per use | `ANTHROPIC_API_KEY` | Monthly spend limit in the console + daily budgets on the admin page |
| **AeroDataBox** (via RapidAPI) | Direct flights per airport and day | Free/basic plan | `AERODATABOX_API_KEY` | Monthly unit quota; app guard `AERODATABOX_DAILY_UNITS` |
| **OpenRouteService** (HeiGIT) | Driving times (matrix) | Free Standard key | `OPENROUTESERVICE_API_KEY` | ~500 matrix requests/day; app guard `ORS_DAILY_REQUESTS` |
| **Open-Meteo** | Geocoding, climate history | No account | none | Fair use; cached |
| **Overpass (OpenStreetMap)** | Places and golf courses | No account | optional `OVERPASS_URL`; contact in `INTEGRATIONS_CONTACT` | Slow (25–60 s per query); mirrors maps.mail.ru and overpass.private.coffee; cached 30 days |
| **Wikipedia / Wikivoyage** | "Über das Reiseziel" text | No account | `INTEGRATIONS_CONTACT` (User-Agent) | Cached |
| **Sentry** | Error tracking, budget alert emails | Developer (free), region EU | DSN, org/project slugs, auth token | Monthly error quota |
| **UptimeRobot** | Uptime monitor, keeps Supabase awake | Free | none | 5-minute interval |
| **Synology DiskStation** | Optional off-site copy of backups | Your NAS | Read-only GitHub token on the NAS | Not set up yet (backlog) |

Bundled data, no service needed: airports (OurAirports, public domain), country facts (mledoze/countries, ODbL), daylight (`suncalc` library). Sources and licences: `src/data/README.md`.

## 1. GitHub
The repo `AlexanderKranz/travel-planner` exists.
1. **Settings → Branches**: a rule for `main` that requires the **CI** check before merging. Pull requests only; nothing is pushed to `main` directly.
2. **Settings → Secrets and variables → Actions**: `SUPABASE_DB_URL` and `BACKUP_PASSPHRASE` (steps in `docs/runbook.md` section 3). Keep the passphrase in your password manager too: without it every backup is unreadable.
3. Optional, on the Mac: GitHub CLI (`brew install gh`, then `gh auth login` → GitHub.com → HTTPS → web browser). Lets Claude read PR and CI status.

## 2. Supabase: database and login
1. Sign up at https://supabase.com (GitHub login works).
2. **New project**: name `travel-planner`, region **Central EU (Frankfurt)**, and a strong database password. Save it in your password manager.
3. Copy the connection details:
   - **Integrations → Data API**: "API URL" **without** the trailing `/rest/v1/` (e.g. `https://abcd1234.supabase.co`) → `NEXT_PUBLIC_SUPABASE_URL`. The **Connect** button at the top shows it too.
   - **Project Settings → API Keys**: publishable key (`sb_publishable_…`) → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - **Project Settings → API Keys**: secret key (`sb_secret_…`) → `SUPABASE_SECRET_KEY` (secret, server only)
   - Ignore the "Legacy API keys" (`anon` / `service_role`).
4. **Authentication → URL Configuration**: Site URL = the Vercel production URL (step 4).
5. Auth hook, allowlist and first admin: `docs/specs/phase-1-dashboard-steps.md` and `docs/runbook.md` section 9.

Migrations are applied by the GitHub workflow "Deploy database migrations" on every merge to `main`.

## 3. Anthropic: Claude API
1. Go to https://console.anthropic.com → create an organization if asked → **API Keys → Create key** → `ANTHROPIC_API_KEY`.
2. Under **Billing**, add credit and **set a monthly spend limit**. This is the hard safety net; the admin page's daily budgets are the soft one.

## 4. Vercel: hosting the app
1. Sign up at https://vercel.com with your GitHub account and choose the **Hobby** (free) plan.
2. **Add New → Project** → import `AlexanderKranz/travel-planner`. Vercel detects Next.js automatically.
3. Add the variables from `.env.example` under **Environment Variables** (Production and Preview). See the table at the end.
4. **Deploy.** The production domain is listed under **Settings → Domains**: `https://travel-planner-eta-cyan.vercel.app`. URLs with a random ID (e.g. `travel-planner-kmt63rc8w-…`) belong to a single deployment and are behind a Vercel login, so never use them as the app URL.
5. **Settings → Functions**: region **Frankfurt (fra1)**, close to the database.
6. **Settings → Cron Jobs**: the job `/api/cron/budget-check` comes from `vercel.json` (daily). It needs `CRON_SECRET`; check once with **Run** and look at "Letzter Budget-Check" on the admin page.

Every push to `main` deploys to production; every pull request gets a preview URL. **Rollback:** Deployments → pick an earlier one → **Instant Rollback**.

## 5. AeroDataBox: flight schedules
1. Sign up at https://rapidapi.com and subscribe to **AeroDataBox** on the free/basic plan.
2. Copy the RapidAPI key → `AERODATABOX_API_KEY`.
3. Usage: RapidAPI dashboard → Analytics. The app spends 2 units per airport and half day and refuses lookups beyond the daily guard (admin page "Einstellungen"). Details: `docs/runbook.md` section "AeroDataBox quota".

## 5a. OpenRouteService: driving times
1. The openrouteservice.org website may be offline; keys come from the HeiGIT account dashboard (HeiGIT runs OpenRouteService).
2. Create a free **Standard** key → `OPENROUTESERVICE_API_KEY`.
3. Without a key, plans are created without driving times. Quota: `docs/runbook.md` section "OpenRouteService quota".

## 5b. Keyless data sources
Open-Meteo, Overpass and Wikipedia/Wikivoyage need no account. Set `INTEGRATIONS_CONTACT` to a contact email: it goes into the User-Agent, which Wikimedia and Overpass ask for. `OVERPASS_URL` is optional (a preferred mirror); the two fallback mirrors are always tried.

## 6. Login emails: Brevo + Strato (done 2026-10-29)
Supabase's built-in mailer only delivers to members of your Supabase team, so invited people need a real sender.

1. **Brevo** (https://www.brevo.com, free): **Senders, Domains & Dedicated IPs → Domains → Add a domain** `alexanderkranz.de`.
2. **Strato** → domain `alexanderkranz.de` → DNS settings: add the records Brevo shows:
   - the `brevo-code` **TXT** record on the **root domain** (not on a subdomain: a subdomain that has a CNAME cannot also have a TXT record),
   - the two DKIM **CNAME** records,
   - keep the existing **DMARC** record (`p=reject`) as it is.
   Check propagation with `dig TXT alexanderkranz.de @docks19.rzone.de`, then **Authenticate** in Brevo (all green).
3. Brevo → **SMTP & API → SMTP keys → Generate** (standard key). Paste it **only** into Supabase in the next step; it is not stored anywhere else.
4. Supabase → **Authentication → Emails → SMTP Settings → Enable Custom SMTP**: host `smtp-relay.brevo.com`, port `587`, username = the Brevo SMTP login, password = the SMTP key, sender `travel-planner@alexanderkranz.de` and a matching sender name.
5. Supabase → **Authentication → Rate Limits**: emails per hour ≈ **30**.
6. Supabase → **Authentication → Emails → Templates**: paste the Atlas-style templates from `docs/email-templates/`:
   - `magic-link.html` → **Magic Link** and **Confirm signup**
   - `invite.html` → **Invite user** (subject `Einladung zum Reiseplaner · Invitation`)
   The files use HTML entities for umlauts, so they paste correctly from any editor.
7. Test: log in with your own address, and invite a second address from the admin page. Both done 2026-10-29.

Inviting, revoking and common problems: `docs/runbook.md` section 11.

## 7. Monitoring
- **UptimeRobot** (https://uptimerobot.com, free): an HTTP monitor for `https://travel-planner-eta-cyan.vercel.app/api/health` every 5 minutes, with email alerts. It also keeps the free Supabase project from pausing. What to do on an alert: `docs/runbook.md` section 7.
- **Sentry**: see 7b.
- **Budget alerts**: the daily Vercel cron reports to Sentry with the tag `budget_alert=true`; a Sentry alert rule on that tag emails you (`docs/runbook.md` section 10).

## 7b. Sentry: error tracking
The code is in the repo and does nothing until the DSN is set. Docs checked 2026-10-28: https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

1. Sign up at https://sentry.io/signup/ and choose the data region **European Union (Germany)**. It cannot be changed later. The organisation lives at `de.sentry.io`.
2. Note the organisation **slug** (in the URL, `https://<slug>.sentry.io`).
3. **Projects → Create Project → Next.js**, name `travel-planner`. Skip the wizard's code steps. Note the **project slug**.
4. **Settings → Projects → travel-planner → Client Keys (DSN)**: copy the DSN (`https://<key>@o<id>.ingest.de.sentry.io/<id>`).
5. **Settings → Developer Settings → Organization Tokens → Create New Token**, name `vercel-sourcemaps`. It is shown once; put it in your password manager.
6. Vercel → Environment Variables (Production and Preview): `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` (Sensitive). Keep **"Automatically expose System Environment Variables"** on.
7. **Deployments → latest → Redeploy**.
8. Test error: `docs/runbook.md` section 8 (`SENTRY_TEST_ENABLED`).
9. Alerts: the default rule emails you about high-priority issues, plus the budget alert rule from section 7. If the emails land in spam, add a filter rule for Sentry's sender.

## 8. DiskStation backup copy (optional, not set up yet)
The nightly backup lives only as a GitHub artifact for 30 days. `scripts/backup/pull-to-nas.sh` keeps 30 daily and 12 monthly copies on the NAS. Steps: `docs/runbook.md` section 4.

## 9. Local development
```bash
cp .env.example .env.local   # then fill in the values from above
npm install
npm run dev                  # http://localhost:3000
```

## Secrets and settings overview
Settings marked "admin page" can be changed under Admin → Einstellungen without a redeploy; the env value is only the default (`docs/runbook.md` section 12).

| Name | Where | Secret? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Vercel, `.env.local` | no (protected by RLS) |
| `SUPABASE_SECRET_KEY` | Vercel, `.env.local` | **yes** |
| `ANTHROPIC_API_KEY` | Vercel, `.env.local` | **yes** |
| `AERODATABOX_API_KEY`, `OPENROUTESERVICE_API_KEY` | Vercel, `.env.local` | **yes** |
| `CRON_SECRET` | Vercel | **yes** |
| `DEMO_EMAIL`, `DEMO_PASSWORD` | Vercel, `.env.local` | password **yes** |
| `AI_ENABLED`, `DEMO_ENABLED` | Vercel (defaults; admin page) | no. `false` in Vercel is a hard off |
| `AI_*_USD`, `AERODATABOX_DAILY_UNITS`, `AERODATABOX_MIN_REMAINING`, `ORS_DAILY_REQUESTS`, `ALERT_ERRORS_24H` | Vercel (defaults; admin page) | no |
| `APP_URL` | Vercel, only for a custom domain | no |
| `INTEGRATIONS_CONTACT`, `OVERPASS_URL` | Vercel, `.env.local` | no |
| `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Vercel | no |
| `SENTRY_AUTH_TOKEN` | Vercel (build) | **yes** |
| `SENTRY_TEST_ENABLED` | Vercel, only while testing | no |
| `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE` | GitHub → Settings → Secrets → Actions | **yes** |
| Brevo SMTP key | Supabase → Authentication → SMTP Settings only | **yes** |
| GitHub token for the NAS | NAS config file only | **yes** |
