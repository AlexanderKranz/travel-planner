# ADR 0007: Find destinations by driving time

Status: accepted (Alex, 2026-11-01) · Date: 2026-11-01 · Spec: `docs/specs/find-destinations-drive.md` (section 11 lists every default)

## Context
Without airports a destination search has no distance filter, so places within driving range cannot be requested. Flight estimates are computed offline, but a drive time needs ORS, a daily quota and a network that can fail. ORS also routes over ferries (Marbella to Palma came back as 15 h), and the 180-minute cap that hides this for plans is too short for a driving search. Profiles store a home name but no coordinates.

## Decision
1. **Flight or drive is one exclusive choice per search,** stored as `travel_mode` with the default `flight`.
2. **ORS decides, the radius only hints.** Haiku gets a straight-line hint, code applies a generous cutoff to save calls, and the ORS time is authoritative.
3. **Ferry-free routes are requested per place** through Directions, with "no road" cached as a result. The cache key is per place pair, because a matrix key over a whole idea list would almost never hit. One matrix request replaces this only if a live spike shows that it honours the ferry option.
4. **Home coordinates are stored on the profile and copied to the search,** resolved by the server from `geoId`. Existing homes are picked again; there is no guessing from a name.
5. **A drive card always carries a verified time.** This is a deliberate exception to "a provider failure shows Not checked" (ADR 0006): an unchecked drive would show what the user excluded. A gate before the LLM call avoids spending tokens on a search that cannot be verified.

## Consequences
- A cold round costs usually 5 or 6 ORS requests, at most 8, against the cap shared with plans. 50 requests are kept for plans.
- Ferry-only islands disappear from drive results, and Britain and Ireland probably do too. Bridged islands pass.
- `IDEAS_PROMPT_VERSION` moves to `ideas-3`, so each same-input flight search misses the cache once. Saved lists stay valid.
- Users with a saved home pick it once more before their first drive search.
- The ORS Directions request and its "no route" error are unverified until the spike, because the ORS docs were down when the client was written.
- Drive times exclude traffic and breaks, and the UI says so.
