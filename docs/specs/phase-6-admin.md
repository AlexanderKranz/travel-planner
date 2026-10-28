# Phase 6 spec: admin page, budget alerts, keep-alive

Status: implemented on branch `phase-6/admin` (backend-dev). Decisions are numbered **[D#]**. Operations: `docs/runbook.md` sections 9 and 10.

## 1. What exists

| Piece | Where |
|---|---|
| Migration | `supabase/migrations/20261102120025_admin_stats.sql` |
| pgTAP | `supabase/tests/rls.test.sql` (end of file, "phase 6") |
| Admin gate | `src/lib/server/admin/gate.ts` (`requireAdmin()`) |
| Aggregate reads + shaping | `src/lib/server/admin/{stats,schema,shape,config,periods}.ts` |
| Page | `src/app/[locale]/app/admin/page.tsx`, `src/components/admin/*` |
| Budget rules / run / auth | `src/lib/server/admin/{budget,budget-run,cron-auth}.ts` |
| Cron route + schedule | `src/app/api/cron/budget-check/route.ts`, `vercel.json` |
| Health (shared) | `src/lib/server/health.ts` (used by `/api/health` and the admin page) |

## 2. Decisions

- **[D1] Role already exists.** `profiles.role in ('user','admin')` with no user column grant (phase 1) and `private.is_admin()`. No new role table. The operator promotes himself with one SQL statement (runbook section 9). The demo account can never be admin (existing check constraint).
- **[D2] Route is `/[locale]/app/admin`.** Under the existing `app` layout, so the middleware already requires a session. The page calls `requireAdmin()` first; non-admins, signed-out visitors and read errors get `notFound()`. The nav link renders for admins only (the link is cosmetic, the gate is the server check).
- **[D3] Reads go through five SQL functions, secret key only after the admin check.** `admin_user_stats`, `admin_usage_stats`, `admin_ai_stats`, `admin_api_stats`, `admin_recent_events` return jsonb aggregates. They are executable by `service_role` only (revoked from public, anon, authenticated), like `ai_spend_micro_usd`. Even an admin's user session cannot call them (pgTAP). All except `admin_user_stats` are `security invoker`; `admin_user_stats` is `security definer` with `search_path = ''` because it reads `auth.users.last_sign_in_at`. Results are parsed with Zod in `schema.ts`. `getAdminDashboard()` and `getHealthInfo()` call `requireAdmin()` themselves, so a new caller cannot forget it (unit-tested: a non-admin never creates the admin client).
- **[D4] Privacy.** No user ids, emails, names or content leave the DB. `admin_recent_events` returns event, level, route, time and a reason class (`props.reason`/`code`/`error`/`kind`, 60 chars max), not `props`, `user_id` or `request_id`. A Zod/test check asserts the shaped dashboard contains no user identifiers.
- **[D5] Definitions.** Users exclude the demo account (reported in its own block via `auth.demo_login` events and `ai_usage.is_demo`). "Active" = `last_sign_in_at` in the window OR any `app_events` row of their own except `share.viewed` (sessions can last long without a new sign-in). Plans per day = `plan_versions` of kind `generate` and `patch` per Europe/Berlin day, 14 days. "Calls" in the API table include cache hits; error rate and p50/p95 use real requests (`cache <> 'hit'`) only, latency percentiles successful ones only. Cache-hit share of AI = `cache_read / (input + cache_read + cache_creation)` tokens (prompt cache). All periods are Berlin days/months (`periods.ts`), matching the AI, ORS and AeroDataBox guards.
- **[D6] Task list.** The AI task breakdown always shows `purpose_tags`, `group_parse`, `plan_generate`, `plan_patch` (zero when unused).
- **[D7] Overpass mirror usage needs a new column.** `api_calls.variant` (host name, constrained to `^[a-z0-9.-]+$`) is set by the Overpass fetcher from the mirror that answered (`runQuery()` now also returns `mirror`). Rows from before this change show as "unknown". The column is only sent when set, so other `api_calls` inserts do not depend on the migration being applied.
- **[D8] AeroDataBox monthly remaining** is the last `quota_remaining` reported by RapidAPI (not computed from a calendar month, because the billing cycle is unknown). The page shows units today vs `AERODATABOX_DAILY_UNITS`, units this month, remaining, and the level (warn below 2x `AERODATABOX_MIN_REMAINING`, over below 1x), the same rule as the cron.
- **[D9] No chart library.** Labelled horizontal bars (`components/admin/parts.tsx`), value text carries the number (colour is only a hint), progress bars have `role="progressbar"` and a label. Tables scroll horizontally at 360 px.
- **[D10] Cron.** `vercel.json` `crons`: `30 20 * * *` UTC (daily, Hobby-compatible; late evening Berlin so the day is nearly complete; Hobby timing has up to 1 h jitter). Route `GET /api/cron/budget-check` checks `Authorization: Bearer <CRON_SECRET>` with a constant-time digest compare. Missing/wrong header, or `CRON_SECRET` unset: 401, nothing runs (fails closed). `/api` is outside the middleware matcher.
- **[D11] Thresholds** (pure, `budget.ts`): `ai_daily` warn at 80 % / error at 100 % of `AI_GLOBAL_DAILY_USD`; `ai_monthly` the same against the new `AI_MONTHLY_ALERT_USD` (default 10; the 80 % rule is my choice, the brief only named the env var); `aerodatabox_monthly` warn below 2x `AERODATABOX_MIN_REMAINING`, error below 1x, silent while unknown; `ors_daily` warn 80 % / error 100 % of `ORS_DAILY_REQUESTS`; `errors_24h` warn above `ALERT_ERRORS_24H` (new, default 20), error above 2x. A cap of 0 disables a check. `budget.alert` events are excluded from the error count so alerts do not feed each other.
- **[D12] Delivery and dedupe.** Each alert writes `app_events` `budget.alert` (level warn/error, props `kind` plus numbers) and `Sentry.captureMessage("Budget alert: <kind>", { level: "warning", tags: { budget_alert: "true", alert_kind, alert_level }, fingerprint: ["budget-alert", kind, <berlin date>] })` followed by `Sentry.flush(2000)`. Sentry is initialised server-side in `src/sentry.server.config.ts` (via `instrumentation.ts`, only when `NEXT_PUBLIC_SENTRY_DSN` is set); without a DSN `captureMessage` is a no-op. The date in the fingerprint makes each day a new Sentry issue, because a "new issue" alert rule would otherwise fire only for the first day ever. Dedupe: before delivery the run looks for a `budget.alert` event with the same `props.kind` since the Berlin midnight; at most one alert per kind per day. Sentry level is always `warning` (as requested); the real severity is in `alert_level`.
- **[D13] Keep-alive.** Checked: `backup.yml` runs `pg_dump` over the pooler, which Supabase does not document as project activity; UptimeRobot on `/api/health` is documented in hosting-setup but not confirmed to be configured. So the daily cron reads the database (RPC sums, counts) and logs `cron.budget_check` every run, which also proves the cron is alive (shown under Health as "Last budget check"). `/api/health` is unchanged in behaviour (its DB check moved to `src/lib/server/health.ts` so the admin page can reuse it).
- **[D14] Not done (kept small).** No invite/allowlist management UI, no shares-opened or PDF-exported counts, no "last backup/deploy" tile (backup does not write to `app_events` yet), no per-user top consumers (would be per-user data). `api_calls` retention (90 days) is still the later cleanup job.

## 3. Tests

Vitest: `shape.test.ts` (aggregate shaping, meters), `budget.test.ts` (every threshold edge), `budget-run.test.ts` (dedupe, Berlin day window, keep-alive log), `cron-auth.test.ts` and `app/api/cron/budget-check/route.test.ts` (401 for missing/wrong/unset secret, 200, 500), `gate.test.ts` (non-admin/signed-out/read error -> 404, admin reads never reach the secret-key client, key presence is booleans only), `periods.test.ts` (Berlin day/month incl. DST), `overpass.test.ts` (mirror label). pgTAP: execute privileges (anon/authenticated denied, service_role allowed, also for an admin user session), result shapes, no user id in recent events, `variant` constraint.

## 4. Needs Alex

1. **Merge, then let "Deploy database migrations" apply `20261102120025_admin_stats.sql`** (done by merging to `main`; I did not touch the remote project).
2. **Make yourself admin** (Supabase SQL Editor, after you have signed in once; replace the email):
   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'you@example.com');
   ```
3. **Vercel env vars (Production):**
   - `CRON_SECRET` (required for the cron; `openssl rand -base64 32`)
   - optional: `AI_MONTHLY_ALERT_USD` (default 10), `ALERT_ERRORS_24H` (default 20)
   - existing caps stay as they are: `AI_GLOBAL_DAILY_USD`, `AERODATABOX_MIN_REMAINING`, `ORS_DAILY_REQUESTS`
4. **Sentry alert rule** for budget alerts: Alerts -> Create Alert -> Issues -> condition "A new issue is created", filter "The event's tags match `budget_alert` equals `true`", action "Send a notification to" yourself -> Save. Details in runbook section 10.
5. After the first deploy: Vercel -> Settings -> Cron Jobs -> **Run** once, then check the admin page Health tile "Last budget check".
6. Optional: confirm the UptimeRobot monitor on `/api/health` exists (the cron covers keep-alive either way).
