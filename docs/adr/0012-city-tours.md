# ADR 0012: City tours

Status: accepted (Alex, 2026-11-12, all recommendations T1–T19) · Date: 2026-11-12 · Spec: `docs/specs/city-tour.md` · Issue #172

## Context
Alex wants to name a few places in a city and get a proper tour: a sensible order, the route between the places with a choice like "fastest" or "most scenic", sights on or near the way, and time limits. A tour can stand alone or belong to a day of a trip.

## Decision
1. **Own resource `city_tours`** (owner RLS), input as jsonb, optional link `(trip_id, trip_day)` to an own trip through a composite same-owner FK that sets `trip_id` null when the trip is deleted.
2. **No LLM.** Order (exact Held–Karp over one ORS matrix), timing, titles and proposals are code. Rule 2 gets no new allowed use.
3. **Facts from APIs.** Leg times, distances and geometry from openrouteservice; places from the cached city places plus Geoapify Autocomplete; sights near the route filtered in code from cached OSM places; sunset from `suncalc`. Dwell times are the user's estimate and labelled so.
4. **Honest route options.** `fastest`, `shortest`, `green`, `quiet`, `no_steps`, `no_highways`, named by what ORS does; no "scenic" label. Waterfront routing is phase 2.
5. **Result snapshot written only by the server** with the secret key after an RLS read; share pages and the PDF read only the snapshot.
6. **Map:** MapLibre GL JS with OpenFreeMap tiles, lazy-loaded on tour views; SVG sketch in the PDF; Google Maps deep link.
7. **Sharing:** only through a shared trip (read-only) in the MVP; own tour shares later.
8. **Plan:** a linked tour with a start time enters the plan as a fixed `activity` slot; a code guard drops duplicate refs on that day.
9. **Quotas:** ORS gate with the plan reserve, 20 computations per user per day, 90-day route caches; the ORS cap is split by endpoint.

## Consequences
- One new table, two new ORS client functions, one new Geoapify endpoint, one new client library (MapLibre, about 220 kB gz on tour pages only) and a new third party in the privacy text (OpenFreeMap tiles).
- Route options whose data ORS lacks in an area have a small effect; the help text says so.
- Public transport is not offered.
