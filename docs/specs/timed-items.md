# Timed cost items in the plan (plan-4)

Status: implemented on `feat/timed-items`, decisions below await review.

## Problem

A flight added via "+ Eintrag" in the plan's flight list showed up only in the costs. Cost items had no time, so
the itinerary could not show them, and the model planned golf at 14:00 on a day whose booked flight lands at 16:00.

## What changed

- `trip_items.start_time` / `end_time` (migration `20261101120023_trip_item_times.sql`), `TripItemInput.startTime` /
  `endTime`, mapping, item form (two native time fields), items list, share view and PDF list.
- One entry point, as before: every item still goes through the same item form. The flight row's quick add now
  prefills category, title, trip day and dep/arr times. With category "Flug" the form offers a select of the
  plan's verified flights that fills the same fields. Manual entry still works.
- Booked/planned items with a day and a start time are fixed slots. They go into the LLM input as `fixed` and are
  rendered by code into the day cards (web, share page, PDF) at render time, so editing an item updates the plan
  view without a new AI call.
- Prompt `plan-4`: one new rule (13) plus one patch line. The system prompt stays static, so caching is unchanged.
- Flight lists (plan, facts panel, ±1 day blocks) use one shared grid row.

## Decisions to review

- **[D1] Times are text `HH:MM` with a check constraint**, not Postgres `time`. App, plan JSON and LLM input all
  use HH:MM strings, and `time` would come back as `07:50:00` and need mapping. `end_time` requires `start_time`
  (check `trip_items_end_needs_start`). Column grants were extended to the two columns.
- **[D2] End before start is allowed for every category** and means "ends the next day" (overnight flight, late
  dinner). There is no category-specific validation. The UI shows `23:10–01:20 +1`. For overlap checks such an
  item runs until midnight.
- **[D3] Which items enter the plan:** status `booked` or `planned`, a day within the trip and a start time.
  Options, rejected items and items without a day or time stay in the costs and items list only.
- **[D4] LLM input:** `fixed: [{day, from, to?, cat, title?}]`, sorted. There are no ids or status. Flights carry
  no title, so flight numbers stay out of the prompt (rule 4 already forbids them in prose). Other categories send
  their title cut to 60 characters (user data, rule 14). The input hash includes `fixed`, so changed items lead to
  a real new generation.
- **[D5] Booked flights take precedence in code too.** A fixed flight on day 1 removes `flights.out` from the input,
  and one on the last day removes `flights.back`. The model then plans from the booked times only (rule 13: start
  at least 90 min after its end on day 1, end at least 150 min before its start on the last day). `plan.flights`
  (the UI snapshot) is unchanged. `planned` flights count like `booked` ones.
- **[D6] Code guard for overlaps.** After assembling (generate and patch), timed activities that overlap a fixed
  item of their day are dropped and counted as `fixed_overlap` in the logged issues. The 90/150 min buffers are
  prompt-only and checked by the evals, because shifting or dropping activities for them would be guesswork.
- **[D7] Merge rule for rendering:** each fixed item goes before the first activity (in plan order, across stops)
  whose time is at or after its start. Activities without `at` take the time of the next timed activity in their
  stop, so an untimed "Arrival and transfer" follows the arrival flight. Items with no later activity go to the end
  of the last stop. A fixed row shows the time range, category, title and a status badge ("Gebucht"/"Geplant").
- **[D8] "Items changed" hint:** a small note on the latest version when an item with day and start time has
  `updated_at` later than the version. Not detected: deleted items (their rows simply disappear) and code-only
  versions (swap days, restore) created after the change. Regenerating clears the hint.
- **[D9] Share page and PDF render the same merged rows, but only when the link shares items.** Without items in
  the link, no item data leaves the server, and fixed rows are left out as well.
- **[D10] Flight list layout:** one heading per direction and route ("Hinflug · Sa., 10. Juli · FRA → CPH"), one
  CSS grid row per flight (`07:50 – 09:15 · LH 826` / `1 h 25` + action). On phones line 1 holds times + number and
  line 2 holds duration + action, always right-aligned. From `sm` up it is a single line. The list owns the
  columns and rows use `subgrid`, so durations and actions line up within a group. The facts panel and the ±1 day
  blocks use the same row (airline, weekdays and the limit note sit in the duration cell).
- **[D11] "Already an item" detection:** a non-rejected item of category flight whose title contains the flight
  number (with or without a space, not as a prefix of a longer number) on the same trip day. The row then shows
  "✓ Gebucht/Geplant/Option" instead of the add action. The flight select in the form lists the fitting legs of
  the latest plan, both in the plan view and in the items section.
- **[D12] Always-available "Plan neu erstellen" (coordinator request).** It sits as a small secondary card in the
  plan's right column under the versions, on the latest version only. It asks inline first ("Creates a new
  version with AI; the current one stays in the version history"). It sends `fresh: true` (skips the input-hash
  dedupe, so the model is really called again) plus `force: true` (pending places do not block). It is disabled
  when AI is off, and the budget and rate limits apply as usual. It is not an item entry point.
- **[D13] Drive times are hidden by default (user feedback).** A "Fahrzeiten anzeigen" checkbox at the top of the
  plan (owner and share view) shows them. The choice is per viewer in localStorage (`tp.showDriveTimes`; storage
  errors are ignored). Day cards stay server components: a small client wrapper sets `data-drive` and the badges
  and the "© openrouteservice.org" credit are shown via CSS. Drive times are still computed and sent to the model.
  The PDF omits them, and its sources line no longer names openrouteservice.
- **[D14] Quick add in day rows: icon-only "+" in a reserved right column** (44 px). The text can never wrap around
  it. On hover-capable pointers it is invisible until the row is hovered or focused (`@media (hover: hover)`, still
  in the tab order and visible on focus). On touch devices it stays visible as a small "+". This is cleaner than a
  disclosure row, which would turn the place link inside the row into nested interactive content. Its accessible
  name and tooltip are "Kostenpunkt hinzufügen: <place>".
- **[D15] "Eintrag" → "Kostenpunkt" / "item" → "cost item"** wherever it means a trip item: add button, quick
  add, empty state, limit, cost summary counts, share options and the new hints. Group entries and generic errors
  keep their wording. The flight list keeps a text link "+ Kostenpunkt hinzufügen".
- **[D16] Wider desktop layout (coordinator request).** The app shell container is `max-w-7xl` with responsive
  padding. Pages keep reading width (`max-w-3xl`) unless their `<main>` sets `data-wide`, which only the trip page
  does. At `lg` the trip page uses a 2/3 + 1/3 split (min 20 rem) for the plan with a sticky side column
  ("Plan anpassen", budget, versions, regenerate) that scrolls on its own above viewport height, for items next to
  sharing, and for the facts panels. The trip context is a 3-column strip at `lg` (2 at `sm`, stacked on phones).
  Flight pair cards sit in 2 columns at `xl`. Phones are unchanged.

## Patches

Patches reuse the stored INPUT (cached prefix). When the current fixed slots differ from `INPUT.fixed`, they are
sent as `CURRENT_PLAN.fixed` (`[]` when all were removed), and the addendum says it replaces `INPUT.fixed`. The
overlap guard [D6] uses the current slots.

## Evals

The golf fixture now has a booked LH 1150 FRA → AGP 13:00–16:00 on day 1 (the later of the two verified flights,
so precedence is tested), a booked dinner on day 3 at 20:00–22:00 and an option (must stay out). New checks run on
the model's raw output (before the guard): day-1 activities ≥ arrival end + 90 min, last day ≤ departure − 150 min
(when booked), no overlap. A separate check asserts the stored plan never overlaps.

| Day-1 timing (golf) | First timed activity | Required | Overlaps |
| --- | --- | --- | --- |
| plan-3 recording vs. new fixture (before) | 14:00 golf (during the flight) | ≥ 17:30 | 2 (golf d1, tapas d3 20:00) |
| plan-4 live 2026-10-28 (after) | 17:30 arrival/car, 18:15–19:45 9 holes | ≥ 17:30 | 0 |

Golf generate and patch were re-recorded with plan-4, and all checks pass. Cruise was not re-recorded (see below).
Its plan-3 recordings still pass, and the stale-hash rule skips model-dependent checks.

Tokens (golf): generate before plan-3: in 2316 + cache read 2842, out 1589, $0.021. After plan-4: in 2309 + cache
write 3074 (cold cache after the prompt change; the system block grew by about 230 tokens), out 2778, $0.040.
Patch before: in 616, cache write 2312 / read 3034, out 185, $0.009. After: in 747, cache write 5625, out 480,
$0.020 (cold).

## Known limits

- The cruise fixture has not been re-recorded with plan-4. A cruise generate needs a $0.15 ledger reserve, which
  would have exceeded this task's $0.20 cap.
- Overnight items do not spill into the next day's rows.
- An item title that only names the route ("FRA → AGP") is not recognised as holding a leg.
