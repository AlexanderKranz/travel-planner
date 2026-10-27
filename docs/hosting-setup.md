# Hosting Setup — Step by Step

This guide is for setting up the Travel Planner's cloud accounts for the first time. Do the steps in order. Each step says what to copy and where it goes. Real keys go only into `.env.local` (on your Mac) and the Vercel/GitHub settings, never into the repo.

> Free-tier limits and dashboard menu names change over time. If a screen looks different, look for the same concept nearby.

## How the pieces fit together
```
Browser (phone / desktop)
   │  https://<project>.vercel.app
   ▼
Vercel ── runs the Next.js app (pages + server functions), deploys on every git push
   │
   ├──► Supabase (Frankfurt) ── Postgres database + login (Auth) + Row-Level Security
   ├──► Anthropic API ──────── Claude, only for itinerary text
   ├──► AeroDataBox ────────── verified flight schedules
   └──► Open-Meteo / OSM ───── weather, places (no key needed)

GitHub ── code + CI checks + nightly database backup ──► DiskStation (off-site copy)
```

## 1. GitHub (done ✅)
The repo `AlexanderKranz/travel-planner` exists. Later, under **Settings → Branches**, add a rule for `main` that requires the **CI** check to pass before merging.

## 2. Supabase: database and login
1. Sign up at https://supabase.com (GitHub login works).
2. **New project**: name `travel-planner`, region **Central EU (Frankfurt)**, and a strong database password. Save it in your password manager.
3. Copy the connection details:
   - **Integrations → Data API**: "API URL" **without** the trailing `/rest/v1/` (e.g. `https://abcd1234.supabase.co`) → `NEXT_PUBLIC_SUPABASE_URL`. The **Connect** button at the top shows it too.
   - **Project Settings → API Keys**: publishable key (`sb_publishable_…`) → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - **Project Settings → API Keys**: secret key (`sb_secret_…`) → `SUPABASE_SECRET_KEY` (secret, server only)
   - Ignore the "Legacy API keys" (`anon` / `service_role`).
4. Under **Authentication → URL Configuration**, set the Site URL to your Vercel URL once you have it (step 4).

Free projects pause after about a week without traffic. The uptime monitor (step 6) prevents this.

## 3. Anthropic: Claude API
1. Go to https://console.anthropic.com → create an organization if asked → **API Keys → Create key** → `ANTHROPIC_API_KEY`.
2. Under **Billing**, add credit (e.g. €10 is plenty to start) and **set a monthly spend limit**. This is your hard safety net against runaway costs.

## 4. Vercel: hosting the app
1. Sign up at https://vercel.com with your GitHub account and choose the **Hobby** (free) plan.
2. **Add New → Project** → import `AlexanderKranz/travel-planner`. Vercel detects Next.js automatically.
3. Before the first deploy, add the variables from `.env.example` under **Environment Variables** (Production and Preview).
4. **Deploy.** The production domain is listed under **Settings → Domains**. Ours is `https://travel-planner-eta-cyan.vercel.app`. URLs with a random ID (e.g. `travel-planner-kmt63rc8w-…`) belong to a single deployment and are behind a Vercel login, so never use them as the app URL.
5. Under **Settings → Functions**, set the region to **Frankfurt (fra1)** so it's close to the database.

From now on, every push to `main` deploys to production, and every pull request gets its own preview URL. **Rollback:** Deployments → pick an earlier one → **Instant Rollback**.

## 5. AeroDataBox: flight schedules (phase 1 spike)
1. Sign up at https://rapidapi.com and subscribe to **AeroDataBox** on the free/basic plan.
2. Copy the RapidAPI key → `AERODATABOX_API_KEY`.

## 5b. Login emails (before inviting anyone): open to-do
Supabase's built-in mailer only delivers to members of your Supabase team, so family and friends would never get their login link. Before inviting anyone, set up your own sender under Supabase → Authentication → Emails → SMTP Settings:
- **With your own domain:** Resend (free, 3,000 mails/month). Add the DNS records Resend shows you.
- **Without a domain:** Brevo (free, 300 mails/day) with a verified sender address.

## 6. Monitoring (phase 0/1)
- **UptimeRobot** (https://uptimerobot.com, free): add an HTTP monitor for `https://<your-app>/api/health` every 5 minutes, with email alerts.
- **Sentry** (free developer plan): see 6b below.

## 6b. Sentry: error tracking
Sentry emails you when the app crashes. The code is already in the repo and does nothing until you set the DSN. Docs checked 2026-10-28: https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

1. Go to https://sentry.io/signup/. When asked for the **data storage location / region**, choose **European Union (Germany)**. You cannot change this later. Your organisation will live at `de.sentry.io`.
2. Create the organisation (name it as you like) and note its **slug** (visible in the URL, `https://<slug>.sentry.io`).
3. Create a project: **Projects -> Create Project -> platform Next.js**, name `travel-planner`, alert "on every new issue" is fine. Skip the wizard's code steps (the code is done). Note the **project slug**.
4. Copy the DSN: **Settings -> Projects -> travel-planner -> Client Keys (DSN)**. It looks like `https://<key>@o<id>.ingest.de.sentry.io/<id>`. It is not a password, but treat it tidily.
5. Create the token for source maps: **Settings -> Developer Settings -> Organization Tokens -> Create New Token**, name `vercel-sourcemaps`. Organization tokens are limited to the scopes needed for CI (releases and source-map upload) and cannot read your issues. Copy it immediately; it is shown once. Put it in your password manager.
6. In Vercel: **Project -> Settings -> Environment Variables**, add for Production and Preview:
   - `NEXT_PUBLIC_SENTRY_DSN` = the DSN
   - `SENTRY_ORG` = org slug
   - `SENTRY_PROJECT` = project slug
   - `SENTRY_AUTH_TOKEN` = the token (mark as Sensitive)
   Also make sure **Settings -> Environment Variables -> "Automatically expose System Environment Variables"** is on (it provides `VERCEL_ENV` and `VERCEL_GIT_COMMIT_SHA`).
7. **Deployments -> latest -> Redeploy** (env vars only apply to new builds). In the build log you should see no errors; source maps are uploaded and removed from the output.
8. Verify with a test error: see `docs/runbook.md` section 8 ("Test that it works"). It uses the `SENTRY_TEST_ENABLED` variable.
9. Alerts: Sentry -> Alerts -> the default rule "Send a notification for high priority issues" emails you. Check the notification email under your user settings.

Free tier note: the Developer plan has a monthly error quota (check https://sentry.io/pricing/); the app sends errors only (no tracing, no replay), so a family-sized app stays far below it.

## 7. Local development
```bash
cp .env.example .env.local   # then fill in the values from above
npm install
npm run dev                  # http://localhost:3000
```

## Secrets overview
| Name | Where | Secret? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Vercel, `.env.local` | no (protected by RLS) |
| `SUPABASE_SECRET_KEY` | Vercel, `.env.local` | **yes** |
| `ANTHROPIC_API_KEY` | Vercel, `.env.local` | **yes** |
| `AERODATABOX_API_KEY`, `OPENROUTESERVICE_API_KEY` | Vercel, `.env.local` | **yes** |
| `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Vercel | no |
| `SENTRY_AUTH_TOKEN` | Vercel (build) | **yes** |
| `SENTRY_TEST_ENABLED` | Vercel, only while testing | no |
| `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE` | GitHub → Settings → Secrets → Actions (phase 1, see `docs/runbook.md`) | **yes** |
