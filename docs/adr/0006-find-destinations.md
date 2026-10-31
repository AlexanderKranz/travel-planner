# ADR 0006: Find destinations by trip purpose

Status: proposed (defaults pending review by Alex) · Date: 2026-10-31 · Spec: `docs/specs/find-destinations.md` (section 12 lists every default)

## Context
Users want to start from a trip purpose instead of a destination. The backlog entry of 2026-10-28 proposed filtering candidates by verified direct flights, but scanning departures costs about 120 AeroDataBox units per airport and month, against a 400-unit monthly quota. Ground rule 1 forbids LLM facts, rule 2 keeps tokens minimal and lists every allowed LLM use, rule 6 requires owner-only data, rule 8 requires caching and quota respect.

## Decision
1. **The LLM proposes, code decides.** One call returns place ideas with a one-line reason. Code verifies existence, flight radius, climate and POIs, and drops real failures. The output schema has no field for flights, routes, prices, hours or distances. This is a new allowed LLM use and needs a line in ground rule 2.
2. **No flight API in the search.** A flight limit becomes a radius, computed from the formula the flights panel already uses plus a 10-minute tolerance (1,330 km for 2 h). Cards show a labelled estimate and claim no direct flight. The real check stays in the existing feature, after selection, under its existing quota.
3. **The verified thing is an anchor town.** Regions and islands are labels around a real town, which reuses the existing region destination.
4. **Lists live in a new owner-scoped table,** not `api_cache`, because they derive from personal context. The cache is per owner.
5. **A provider failure is not a negative result.** It shows as "Not checked"; only a real negative drops a place.
6. **Cold searches are capped** at 5 climate misses, no Overpass and 2 rounds, to stay inside Open-Meteo's per-minute limit.

## Consequences
- The estimate runs low (golf fixture: 167 min against a real 180), so some suggestions fail the flight check afterwards. The saved list makes going back free of AI cost.
- Qualities such as "flat" or "relaxing" stay unverified, and the UI must say so.
- Places with no fast POI source (skiing, for now) are shown as "Not checked", not verified.
- Verification lookups share cache keys with trip facts, so a selected place starts with its climate and POIs already cached.
- Picking several suggestions leaves several trips against the 30-trip cap until a later phase reuses the trip.
- Climate thresholds are starting values that need tuning on real results.
