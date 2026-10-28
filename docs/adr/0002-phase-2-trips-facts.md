# ADR 0002: Phase 2 trips, destination facts, API cache

Status: proposed (written overnight, defaults pending review by Alex) · Date: 2026-10-28 · Spec: `docs/specs/phase-2-trips-facts.md` (section 13 lists every default)

## Context
Phase 2 adds trips and the first verified facts: climate, daylight, country facts, a short destination summary and candidate places. Ground rules: facts come from APIs or code, never from the LLM (1); deterministic first (2); all context optional (3); owner-only data (6); external calls cached (8). Everything runs on free tiers (Open-Meteo, Overpass, Wikivoyage) from shared Vercel IPs.

## Decisions

1. **One `trips` table, destination stored inline.** Only destination and length are required. Timing is exact start date OR a set of months OR nothing (DB check + Zod discriminated union). Group and purpose are nullable **same-owner composite FKs** with `on delete set null (column)` (Postgres 15+), so a trip can never point at another user's group and deleting a group keeps the trip. `trip_purposes` gets `unique (id, owner_id)` for this.
2. **Destinations: geocoded anchor place + kind (`city | region`) + radius, or free text.** Open-Meteo Geocoding (GeoNames, keyless) has no bounding boxes and Nominatim's policy is restrictive, so a region is a point with a radius and a user-editable display name ("Costa del Sol" around Marbella). The client sends only the GeoNames id; the server resolves coordinates itself (cached), so stored coordinates are never client-supplied.
3. **Climate from the Historical Weather API (ERA5 reanalysis), 2016–2025, aggregated in code to 12 monthly rows**, not the Climate API (CMIP6 projections, not observation-based). The call is large (~105 weighted units) but happens once per location per year; only the aggregate is cached.
4. **Daylight computed with `suncalc`**, no API. Times are UTC instants; the UI formats them in the destination's IANA zone.
5. **Country facts from a static dataset built from REST Countries** (`scripts/countries/build.mjs` → `src/data/countries.json`), same pattern as airports. Deterministic and free of outages. **Plug types are omitted** until a maintained public-domain source is confirmed.
6. **Candidate places from Overpass, one cached query per interest key**, filtered by a static interest → OSM tag table. A `wikidata` tag is the notability filter for broad categories. Interests without a deterministic source (nightlife, cruise, events, custom text, possibly christmas markets) are reported as `no_source`, so phase 3 can flag AI suggestions for them as unverified.
7. **`api_cache` (server-only, no grants) + `api_calls` (admin-readable metadata).** One `cached()` helper does read → fetch → upsert → log, serves expired rows as `stale` when a provider fails, and writes exactly one `api_calls` row per lookup. Payloads are reduced before caching. `api_calls` holds no keys, query text or coordinates.
8. **Facts are computed on view from the cache, not stored per trip.** Each panel streams in its own `Suspense` boundary; saving a trip warms the cache with `after()`. Every fact carries `source`, `fetchedAt` and `stale` (`Fact<T>`), which the UI shows (ground rule 1). `TripFacts` is the shape phase 3 snapshots into `plan_versions`.
9. **Wikivoyage extracts are display-only** (CC BY-SA, shown verbatim with attribution) and are not sent to the LLM.

## Consequences
- No LLM call in phase 2. Phase 3 consumes `TripFacts` + resolved group ages as compact JSON input.
- Months are stored without a year and always mean the next occurrence; a past trip "drifts" to next year (accepted; revisit if trip history matters).
- Overpass availability from Vercel IPs is the main reliability risk; mitigated by 30-day TTL, stale serving and an `OVERPASS_URL` override.
- Two new static datasets/scripts to refresh about yearly (airports, countries).
- `HomeAirports` in `src/lib/domain/profile.ts` must be exported for reuse in `TripInput` (step 0).
- Open-Meteo's free tier is non-commercial, like AeroDataBox Basic; commercial use would need paid plans.
