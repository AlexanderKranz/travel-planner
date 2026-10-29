# Phase 6: E2E tests (mobile + desktop)

Status: implemented on `phase-6/e2e`. Run instructions: `docs/runbook.md` section 13.

## Flows covered
| # | Flow | Spec |
|---|---|---|
| 1 | Sign in (session cookies created from a password sign-in, no email) | `global-setup.ts`, `lib/auth.ts` |
| 2 | Trip without group: facts with source and check date; free-text destination: "unavailable" state | `trips.spec.ts` |
| 3 | Trip with quick group (free text + composition) and with a saved group of named members | `trips.spec.ts` |
| 4 | Plan from a recorded fixture: render, AI-disabled notice, swap days, set best day, versions view | `plan.spec.ts` |
| 5 | Add a booked cost item with times: costs table and fixed row in the day plan | `items.spec.ts` |
| 6 | Share link opened logged out (noindex), revoke gives the same 404 as an unknown token | `share.spec.ts` |
| 7 | Owner PDF (button download and API) and share PDF: `application/pdf`, `%PDF` | `share.spec.ts` |
| 8 | RLS: user B gets 404 on A's trip; Data API reads, updates, deletes and inserts are empty or rejected | `rls.spec.ts` |
| 9 | Admin: normal user 404, signed-out redirect, admin sees the page | `admin.spec.ts` |
| 10 | axe smoke (WCAG A/AA, fails on serious and critical): login, trip page, share page | `a11y.spec.ts` |

Not covered: "iterate" with the AI (AI is off; the code-only edits are covered), the login email/OTP screens, flights (needs AeroDataBox; users in E2E have `wants_flights = false`).

## Decisions
- **[D1] Stub outside the app.** External providers are answered by a preload script (`e2e/stub-fetch.cjs`) that the Playwright `webServer` command adds with `node --require`. It replaces `globalThis.fetch` in the Next server process: Open-Meteo geocoding/archive, Overpass and Wikivoyage are served from the recorded fixtures in `src/lib/integrations/__fixtures__`; any other non-local host (Wikipedia, AeroDataBox, OpenRouteService, Anthropic, Sentry) gets a 503 and a console warning. No application code changed, and production cannot enable it because the file is not imported anywhere and only appears in the E2E start command. Chosen over seeding `api_cache` (keys depend on request details like coordinates and would need to be kept in sync) and over an env-gated stub inside `src/` (extra production surface).
- **[D2] The real code path is exercised.** Facts go through `cached()`, Zod and the real `api_cache` table in the local database; only the HTTP response is replaced.
- **[D3] Sessions without email.** Users are created with the Supabase admin API (allowlist row first, the signup trigger is fail-closed) and signed in with a password through `@supabase/ssr`, which yields exactly the cookies the app reads. They are written to `e2e/.auth/*.json` as Playwright storage state (git-ignored). The OTP login form is not driven.
- **[D4] Plan seeded, never generated.** `plan_versions` rows are inserted with the service key from the recorded `plan-document-cruise.json` fixture. `AI_ENABLED=false` and empty `ANTHROPIC_API_KEY` are set for the server.
- **[D5] Per-project data.** `mobile` and `desktop` each get their own users (`a-<project>`, `b-<project>`), group, and two plan trips. One shared admin. One worker, files in alphabetical order, so flows can build on seeded state without interfering.
- **[D6] Admin role via the service key** (`profiles.role = 'admin'`), the same effect as the SQL in the runbook.
- **[D7] Local-only guard.** The setup throws unless the Supabase host is `127.0.0.1` or `localhost`.
- **[D8] CI job `e2e`** runs in parallel with `check` and `db-test`: local Supabase (same minimal service list as `db-test`), build, Playwright with cached browsers, report and traces uploaded on failure. The reporter also emits GitHub annotations so failures are readable without downloading logs.
- **[D9] Keys.** `scripts/e2e/env.sh` reads the URL and the (public, well-known) local demo keys from `supabase status`. NEXT_PUBLIC values must be present at build time.
- **[D10] a11y.** `@axe-core/playwright`, tags wcag2a/aa and wcag21a/aa, only serious/critical fail.

## Results (first green run, 2026-10-29)
- 32 tests (16 per project) pass; the Playwright step takes about 40 s, the whole `e2e` job about 5 min (Supabase start about 2 min, build 1 min).
- a11y: axe found one serious issue on the trip page and the share page, `color-contrast` of the small uppercase terracotta eyebrow (`text-accent-text`, about 4.4:1 on the cream page). Fixed by darkening `--accent-text` from `#b4532a` to `#a14a22` in `src/app/globals.css`. The login page had no violations.
- Retries are off: several flows change data, so a retry would not start from the seed.
- Gotcha: `browser.newContext()` inherits the project storage state, so the logged-out fixture passes an explicit empty state. The destination test must wait for the geocoded option, because the free-text row appears first.

## App defect found by the suite [D11]
After merging phase-6/hardening the E2E run showed two symptoms: `notFound()` pages answered HTTP 200 (non-admin on `/de/app/admin`, a foreign trip id), and flows that call `router.refresh()` after a server action (plan edits, cost items, share links) intermittently kept showing the old content. Both disappeared when `src/app/[locale]/app/loading.tsx` was removed (run 40835655645: 36/36). A segment-level `loading.tsx` wraps the page in a Suspense boundary, so the shell is flushed with 200 before `notFound()` runs; the status cannot change afterwards. Fix: the file is removed and `src/app/no-loading-boundary.test.ts` fails if any `loading.tsx` comes back; the E2E not-found checks now assert status 404. The trip page already shows skeletons for its slow fact panels through `<Suspense>` below the data that decides 404. The `errorPage.loading` message key is now unused (left in both files). Share pages were never under the boundary (`[locale]/s/[token]`) and always returned 404.
