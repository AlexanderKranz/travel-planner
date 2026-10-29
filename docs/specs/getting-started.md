# Getting started guide (first login)

Status: implemented on `feat/getting-started`, decisions below await review.

## What it is

A skippable four-step welcome page, `/[locale]/app/start`, in the Atlas look (eyebrow, serif heading, numbered cards,
progress bar). Steps: 1 About you (home airports, birthdate), 2 Who travels (name + free-text description), 3 Why you
travel (name + free text), 4 First trip (button to the trip form; only destination + length are required).
No AI calls of its own: creating a group parses its text on save exactly as the group editor does.

## Decisions

- **[D1] Full page plus redirect, not a panel.** `/app` (the dashboard page) redirects to `/app/start` while
  `profiles.onboarding_done_at` is null. A page gives room for four steps with forms and works at 360 px; a panel on
  the trips list would push the real content away. The redirect lives in `app/page.tsx`, not the layout, so every other
  `/app/*` URL (deep links, share, trip pages) stays reachable. Login lands on `/app`, so this covers the first login.
- **[D2] State is one column, `profiles.onboarding_done_at timestamptz`** (migration `20261103120027_onboarding.sql`).
  Added to the existing column-level update grant (revoke + grant pattern of the demo migration); `role` and `is_demo`
  stay out. RLS policies are unchanged. pgTAP covers: starts null, grant present, role/is_demo still ungranted,
  own update works, another user's update affects 0 rows.
- **[D3] Finishing and skipping both set it** (`markOnboardingDone`, idempotent: the first timestamp is kept). Merely
  opening the page does not, so a user who wanders off sees the guide again on the next `/app` visit until they finish
  or skip once. Chosen over marking on first view because a failed page load would otherwise lose the guide.
- **[D4] Existing users are not redirected.** The migration sets `onboarding_done_at = now()` for all profiles that
  exist at deploy time (not only those with a trip: a user without a trip is still an established user). Only profiles
  created later start with null.
- **[D5] Demo account never redirects** (`shouldShowOnboarding` checks `is_demo`); its data is reset, so a redirect
  would repeat for every visitor. It can still open the guide from Einstellungen and the trips empty state.
- **[D6] Step completion is derived** (`src/lib/onboarding.ts`, `deriveSteps`): about = any home airport or a birthdate,
  group/purpose/trip = at least one row. Nothing about steps is stored. A step with "Später" is only folded away
  client-side; it shows as open until data exists.
- **[D7] Inline forms reuse existing parts**: `AirportPicker` and `updateProfile` (step 1), `createGroup` with the
  free-text `description` (step 2), `createPurpose` with free text (step 3). Guided fields and chips stay in the full
  purpose editor (linked via "Manage"). After saving, `router.refresh()` re-derives the steps.
- **[D8] Reopen**: link in Einstellungen (card at the top) and in the trips-list empty state. Not added to the main
  nav, which is already tight at 360 px.
- **[D9] A11y**: one `h1`, each step a `section` labelled by its `h2`; the progress bar is `role="progressbar"` with
  a text value and a polite status line; collapse buttons use `aria-expanded`/`aria-controls`; touch targets 44 px.

## Tests

`src/lib/onboarding.test.ts` (step derivation, redirect rule incl. demo and done), `supabase/tests/rls.test.sql`
(column grant and RLS). Messages: namespace `start` in `messages/de.json` and `messages/en.json`.
