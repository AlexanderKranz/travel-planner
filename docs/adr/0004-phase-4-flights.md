# ADR 0004: Phase 4 verified direct flights

Status: proposed (defaults pending review by Alex) · Date: 2026-10-28 · Spec: `docs/specs/phase-4-flights.md` (section 11 lists every default) · Research: `docs/research/flight-data.md`

## Context
Trips with `wantsFlights` should show which direct flights actually exist between the user's airports and the destination, with times, so the itinerary can respect arrival and departure. Ground rule 1 forbids LLM-invented flights; rule 2 keeps tokens minimal; rule 8 requires caching and quota respect. The only viable source found is AeroDataBox on RapidAPI Basic: 400 units and 1 600 requests per month, 1 req/s, non-commercial use with attribution, schedules up to 365 days ahead, far-future data less complete, failed requests still billed. FIDS cannot filter by destination; routes statistics have no flight numbers.

## Decisions
1. **A flight fact is a code-built `Fact<FlightsFacts>`** for at most 2 origins (trip airports, else profile home airports) × 2 gateway airports (phase 3 nearest-within-150 km rule). It lists pairs with a status (`found`, `none`, `not_published`, `not_checked`) and legs (number, resolved airline, local times, block time, checked date, optional weekdays). No prices; booking links to Google Flights, Skyscanner and airline homepages are built deterministically in the UI.
2. **Lookup chain per trip: routes statistics, then departures, then flight-number dates.** `routes/daily` (6 units) decides whether a gateway is served at all; only then FIDS departures (2 × 12 h windows, 4 units) at the origin on the outbound date and at the gateway on the return date; weekday patterns for at most 2 numbers (2 units each). Cold trip ≈ 18 units, capped at 32. Payloads are normalized and cached per airport/day or airport/month, so they are shared across users and trips.
3. **Dates:** exact trip dates; months mode uses one labelled sample week; undated trips get no lookup. Beyond 360 days the same weekday in the latest past year is used as a labelled proxy ("flown last year, not yet published"), never called verified. Within the horizon, absence is "no direct flight found" up to 180 days ahead and "schedule not yet published" beyond.
4. **Quota guard in code**, checked inside the cache fetcher (cache hits are free): a daily unit cap per Berlin day from `api_calls.units` and a minimum monthly remainder from the stored `x-ratelimit-api-units-remaining` header. Refusals degrade to "not checked" or stale data. Failed calls log their units. Requests are serialized at ≥ 1.1 s. A missing API key disables the feature cleanly.
5. **Lazy loading:** the flights panel uses its own route and client loader (like places); flights are not part of the post-save warm-up, so unopened trips cost no units. The plan pipeline reads the same cache.
6. **Max flight time is deterministic:** a new optional purpose field `maxFlightHours`, else a de/en regex over constraints and text. Too-long legs stay visible but flagged and are excluded from the plan input.
7. **Plan integration keeps the LLM away from flight facts:** the plan input gets only fitting leg times (no numbers or airlines), so prose cannot leak them; gateways with a verified route replace the heuristic arrival airport; `plan.flights` is a code snapshot set during assembly and carried unchanged through patches, edits and restores. Prompt version `plan-2`.
8. **No migration:** existing `api_cache`, `api_calls` (units, quota_remaining) and the `aerodatabox` cache provider suffice.

## Consequences
- With ~10–20 distinct (airport, month) pairs per month the free plan fits; heavy use or many origins exhausts it and shows "not checked" until the next day or month. Pro ($8/month) is the escape hatch; commercial use would require a paid plan.
- Results for far-future months are weaker (proxy or "not yet published"); labels keep this honest.
- Months-mode trips see a sample week, not their real travel days, until dates are set.
- Changing `PLAN_PROMPT_VERSION` changes every input hash once; existing plans are not invalidated, only re-generation no longer hits "unchanged".
- Eval fixtures inject recorded flight facts regardless of the computed proxy date (fixture days are the same weekdays in March 2026, not the exact proxy days).
- Deep-link formats are unofficial and may need occasional fixes; they carry no data we rely on.
