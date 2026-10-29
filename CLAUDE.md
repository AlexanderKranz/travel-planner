# Travel Planner

Multi-user web app: users save reusable travel context (optional travel groups, trip purposes, home airports) and get an iterable travel plan with destination info, weather, verified direct flights and a daily itinerary. Plans can be shared by link and exported as PDF.

Full plan: `docs/architecture.md`. Hosting walkthrough: `docs/hosting-setup.md`. Operations (deploy, rollback, backup/restore): `docs/runbook.md`. Decisions: `docs/adr/`.

## Stack
- Next.js 15 (App Router, `src/` dir) + TypeScript (strict), Tailwind v4
- Supabase: Postgres, Auth, Row-Level Security. Migrations in `supabase/migrations/`
- `next-intl` for i18n, locales in `src/i18n/routing.ts`, strings in `messages/<locale>.json`
- Zod for validating all external data (APIs, LLM output, forms)
- Vitest for unit tests (`*.test.ts` next to the code), Playwright for E2E (later)
- Hosting: Vercel (region `fra1`) + Supabase (Frankfurt)

## Commands
- `npm run dev`: local dev server (http://localhost:3000)
- `npm test`: unit tests · `npm run lint` · `npm run typecheck` · `npm run build`
- Run test, lint and typecheck before reporting work as done.

## Ground rules (apply to every change)
1. **Facts come from APIs, never from the LLM.** Flights (AeroDataBox), weather (Open-Meteo), daylight (`suncalc`), distances (OpenRouteService), country facts and POIs (REST Countries, OSM/Wikivoyage) are fetched by code. The LLM only receives them as input. It must never invent flights, routes, opening hours or prices. The UI shows each verified fact with its source and check date.
2. **Deterministic first, minimal tokens.** If code, an API or a static form can do it, do not call an LLM. Allowed LLM uses:
   - Haiku turns free-text purposes into structured tags (once per purpose, cached)
   - Haiku turns a free-text travel group ("5 Freunde, alle in meinem Alter") into structured travellers (once per text change, cached by text hash; saved entries the user typed always win). Spec: `docs/specs/group-text.md`
   - Sonnet composes the itinerary (one call, compact JSON in and out)
   - Iteration patches only the affected days

   Always validate output with Zod, use prompt caching, and log usage in `ai_usage`.
3. **All context is optional.** A trip needs only a destination and length. A group can be a quick composition ("5 adults ~45"), named members with birthdates, free-text notes, or any mix. Never require a field the user didn't choose to give.
4. **Ages are computed, never stored.** Store birthdates and use `ageOn()` from `src/lib/age.ts` with the travel date.
5. **No hardcoded UI strings.** Every user-visible text goes in `messages/*.json` (de + en, same keys). Plan prose is generated in the user's locale.
6. **Users see only their own data.** Every user table has `owner_id` with an RLS policy `owner_id = auth.uid()`. Shared plans are read through a server route by token only. Secrets stay server-side (never `NEXT_PUBLIC_`).
7. **Mobile first.** Layouts must work at 360 px width and on desktop.
8. **Cache external calls** in `api_cache` (keyed by provider + normalized params), and respect free-tier quotas.

## Conventions
- Server code in `src/lib/server/`, API clients in `src/lib/integrations/<provider>.ts`, pure logic in `src/lib/`
- Dates as ISO strings `YYYY-MM-DD` in data and APIs. Format only in the UI.
- Small, focused files. Name things after the domain (trip, group, purpose, plan, item).
- Reference trips for evals live in `evals/fixtures/` (Danube cruise = family with toddler, Costa del Sol = golf with a friend).
- Log what the admin page needs: every Claude call → `ai_usage`, every external API call → `api_calls`, errors and key events → `app_events`. The admin area shows aggregates only, never other users' content.
