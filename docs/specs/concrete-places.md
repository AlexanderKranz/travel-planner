# Concrete places, alternatives and drive times (plan-3)

Status: implemented on `feat/concrete-places` (2026-10-28). Follows user feedback from the live site: plans said
"Familienfreundlicher Vergnügungspark oder Tiergarten" and "Erste Runde, 18 Löcher, auf einem Platz im Südwesten"
instead of naming the zoo or course.

## Root cause

1. **Places were missing at generation time.** The plan pipeline gave Overpass 30 s. Worse, the budget gate in
   `getPlacesFacts` ran *before* the cache lookup, so with a 30 s budget every interest after the first returned
   `error` even when it was cached. Example: for a golf trip whose interests come from tags (`golf`, `general`),
   only `golf` could ever load in the pipeline.
2. **Interests from free text did not exist while warming.** The background warm-up after creating a trip ran
   with the untagged purpose, so it fetched only `general`. The `golf` interest from "Golftrip mit einem Freund"
   only appeared once Haiku tagged the purpose, which happened inside Generate.
3. **The UI hid the name.** Referenced places showed up as a small grey "· name (x km)" after the generic text.

## What changed

- `cached()` takes `fetchAllowed()`. It is checked only on a miss, right before the network call. Cache hits are
  always served (`src/lib/server/api-cache.ts`, `src/lib/server/facts/places.ts`).
- The pipeline waits up to 110 s for places. If an OSM interest still ends in `error` (not `empty`), the route
  answers `places_pending` (503, Retry-After 60). The UI shows "Try again" and "Generate anyway" (`force: true`).
- The warm-up tags the purpose first, then fetches facts and places (`src/lib/server/warm.ts`). Editing a purpose
  re-warms the 2 latest trips that use it.
- Third Overpass instance: `overpass.private.coffee`, tried after `maps.mail.ru`.
- Place selection (`selectPlaces` in `src/lib/plan/input.ts`): every interest first gets a fair share (40 split
  across the interests that have places, at least 8 each). `general` is capped at 8 when a specific interest
  exists, and remaining slots are filled in purpose order.
- OpenRouteService matrix: one request per generation, from the destination point to all selected places
  (`src/lib/integrations/openrouteservice.ts`, `src/lib/server/facts/drive-times.ts`). The LLM input gets
  `min`, and `PlanPlace.drive` stores `{min, km, source, fetchedAt}`.
- Prompt `plan-3`: activities for an interest that has places must set `ref` and may set `alts` (up to 2). The
  text describes what to do at the place and does not repeat its name. Drive times are never written in text.
- `PlanActivity.alts` (optional, max 2 OSM keys) is validated like `ref` in assemble and in patches. Plans stored
  without `alts` or `drive` still parse.
- UI, share view and PDF: the place name is the lead link (website, then Wikipedia, then OSM). After it come the
  drive time ("🚗 35 Min." on the web, "35 Min. mit dem Auto" in the PDF) and "oder: X · Y". The day footer
  credits openrouteservice.org.

## Decisions (reviewed by Alex 2026-10-28)

- **[D1] Places budget 110 s.** *Accepted by Alex 2026-10-28.* Tagging (~3 s) + places 110 s + ORS 10 s + Sonnet 140 s ≈ 263 s, which stays
  under the route's 300 s maxDuration. Worst case Generate now takes about 2 minutes longer when places are not
  cached. Warming makes that rare.
- **[D2] `places_pending` instead of silently generic content.** *Accepted by Alex 2026-10-28.* This applies only to interests that have an OSM
  source and ended in `error`. `empty`, `no_source` and free-text destinations never block. "Generate anyway"
  always works, so the user is never stuck.
- **[D3] Third Overpass mirror private.coffee.** *Accepted by Alex 2026-10-28.* On 2026-10-28 it answered a tiny query with HTTP 200 after
  204 s. Its OSM data is from 2026-07-24, so it is about 3 months behind. That night all three instances were
  slow or failing (502/504), and the primary answered our family query after 42 s on a later try. The mirror is
  last in the chain and only helps when time is left.
- **[D4] `general` capped at 8 next to specific interests.** *Accepted by Alex 2026-10-28.* This keeps golf courses or family venues from being
  crowded out and saves tokens. If `general` is the only interest, it gets all 40 slots.
- **[D5] Warm-up tags the purpose (Haiku) right after the trip is saved.** *Accepted by Alex 2026-10-28.* This is the same single cached call
  Generate would make, just earlier. It is skipped when AI is off or the budget would not allow it. A side
  effect: saving tags moves `purpose.updated_at`, which is already the case today when Generate tags.
- **[D6] Drive times.** *Accepted by Alex 2026-10-28; Alex will check drive times live.* Driving-car from the destination point, not from the hotel or between places. Values
  that are null and "drives" over 180 min are omitted. ORS routes via ferries (Marbella → Palma came back as
  15 h). Cache key = rounded origin (3 decimals) + hash of the sorted place keys and coordinates, kept 90 days.
  The daily cap `ORS_DAILY_REQUESTS` (default 400) counts non-hit `api_calls` rows and fails closed. Without a
  key or on any error the plan generates without times.
- **[D7] The text no longer repeats the place name** (the UI leads with it). This saves output tokens. Plans
  generated before plan-3 still read fine, because the name is shown as a link either way. *Accepted by Alex 2026-10-28.*
- **[D8] Generic text stays allowed for stops far from the destination** (places lie within their km of the
  anchor). A Danube cruise anchored in Passau gets places near Passau only, so Wien/Linz/Melk activities stay
  generic. Multi-anchor trips (one place query per port) would be the next step if wanted. *Accepted by Alex 2026-10-28.*
- **[D9] Prompt rule 5 tightened:** *Accepted by Alex 2026-10-28 (option 2: strict prompt rule, no code relaxation).* "a fixed stop never gets a time that is not in trip.notes". plan-3 twice
  merged an invented 10:00 start into the departure-only Passau window. That made the stop lose its "from your
  notes" badge, because code only trusts times that appear in the notes. The code rule stays strict on purpose.
- **[D10] `leisure=water_park` includes outdoor pools ("Freibad")**, which are useless in December. They are
  not filtered for now: the model saw the month and picked the indoor Erlebnisbad. A name filter would also
  hide them in summer. *Accepted by Alex 2026-10-28.*

## Evals (recorded with plan-3, all checks pass)

New checks: golf, every `sport` activity has a ref to a golf course (alternatives too); cruise, family places
reach the model and zoo/park-type activities must name a verified family place. Drive times are recorded once
per fixture (`EVAL_TASK=drive`).

| Call | Before (plan-2) in / out / cached | After (plan-3) in / out / cached | Cost before → after |
|---|---|---|---|
| system prompt | 2621 tokens | 2842 tokens | |
| golf generate | 2201 / 1643 / 2621 write | 2316 / 1589 / 2842 read | $0.0274 → $0.0211 |
| golf patch | 692 / 468 / 5006 write | 616 / 185 / 2312 write + 3034 read | $0.0186 → $0.0095 |
| cruise generate | 1886 / 2410 / 2621 read | 2622 / 3728 / 2842 write | $0.0284 → $0.0496 |
| cruise patch | 961 / 571 / 4506 read (plan-1) | 1069 / 637 / 5652 write | $0.0085 → $0.0226 |

The cruise input grew by 10 family places and `min` values (+736 tokens). The higher cruise cost after the
change comes mostly from cache writes (the prompt changed between runs) and a longer answer.

## Known failure modes

- Golf generate once returned only 3 of 5 days (`day_count`). The pipeline rejects that as `invalid_output` and
  the user retries (billed). This existed before; it is not addressed here.
- The model may reuse the same course on day 1 and day 5 (near the airport) or list a course as an alternative
  on one round and use it as the ref of the next round. This is allowed.
- Overpass outages longer than the 110 s budget mean `places_pending`; "Generate anyway" gives the old
  generic plan.
