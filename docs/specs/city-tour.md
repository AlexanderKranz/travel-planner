# City tour: places in, tour out (issue #172)

Status: decided (Alex, 2026-11-12: all recommendations T1–T19 accepted; T5 with the note below). ADR:
`docs/adr/0012-city-tours.md`.

Alex's request (#172): "Plan a city tour from a few places the user names. The tool orders them into a sensible tour
and plans the legs between them." Wanted: route choice per tour or per leg (fastest, most scenic, ...), verified
sights on or near the way, time limits (tour and per stop), standalone or part of a trip (for example one day of the
plan).

Scope: one tour = one city, up to 10 places plus an optional start and end, one day, walking, wheelchair, bike or
car. Not in scope: public transport (ORS has none), multi-day tours, booking, live navigation.

Examples use the fixture towns only: Wien (Stephansdom, Hofburg, Naschmarkt, Belvedere, Riesenrad) and Passau (Dom
St. Stephan, Veste Oberhaus, Ortspitze, Rathaus).

---

## 1. Principles applied

- **Ground rule 1.** Order, leg times, distances, geometry and nearby sights come from ORS, OSM (Geoapify/Overpass
  cache) and code. Nothing in a tour is written by a model.
- **Ground rule 2.** Ordering is a small exact TSP in code over one ORS matrix. Timing is arithmetic. **No LLM step
  [T2]**: there is no judgment or prose the user needs that code cannot give. The title defaults to code text
  ("Wien · 5 Orte").
- **Ground rule 3.** A tour needs only places (at least 2). City, start, end, date, start time, limits, dwell times
  and the trip link are optional.
- **Ground rule 8.** Every ORS and Geoapify call goes through `cached()` and the existing quota guards.

## 2. User flow (mobile first, 360 px)

### 2.1 Standalone

1. `/app` gets a section "Stadttouren" below the trips (hidden when empty) and a button "Neue Stadttour". List at
   `/app/tours`, page at `/app/tours/[id]`, new at `/app/tours/new`.
2. **One form page, top to bottom** (one column at 360 px, `min-h-11` targets):
   - **City** (optional): the existing destination search (`/api/geocode`, Open-Meteo). It centres the place search
     and gives the anchor for sight suggestions. Without a city, the first place is the centre.
   - **Places**: a search field (section 3) and, when a city is set, a collapsed "Vorschläge in Wien" list of verified
     places already in the cache (no network call). Added places form a numbered list: name, source chip, dwell
     select, remove. Drag handle only when "Meine Reihenfolge" is chosen; up/down buttons as the accessible
     alternative.
   - **More options** (collapsed by default): start (search, "none"), end ("same as start", "other place", "none"),
     mode as a 2×2 segmented control (Zu Fuß, Rollstuhl, Fahrrad, Auto), route option (select, only options of that
     mode, section 5), order ("Beste Reihenfolge" | "Meine Reihenfolge"), date, start time, "fertig bis" time, min and
     max duration, default dwell time.
3. **"Tour planen"** computes on the server (section 11) and shows the result on the same page:
   - Summary bar: total time, distance, fit badge ("passt", "18 Min. zu lang", "noch 40 Min. frei"), sunset warning.
   - Map (section 8), 4:3 on phones, collapsible; from `sm` on it sits right of the list.
   - Ordered list: stop rows (number, name, arrive–leave times when a start time is set, dwell) and leg rows between
     them (mode icon, minutes, km, route option, "Ändern"). "Ändern" opens a bottom sheet with mode and route option
     for this leg only.
   - Under each leg: "In der Nähe" chips (section 6) with "+ hinzufügen".
   - Footer: sources and check date, "In Google Maps öffnen".
4. Edits (add, remove, options) mark the result outdated ("Tour neu berechnen"); nothing is recomputed per keystroke.

### 2.2 From a trip day

- The day card menu gets "Stadttour für diesen Tag" (trip owner only in the MVP, [T15]). It opens
  `/app/tours/new?trip=<id>&day=<n>` prefilled by code:
  - city = that day's stop point (`ResolvedStop`, `port-places.md` §1) or the trip destination,
  - places = the day's referenced places that have coordinates in the plan index (OSM keys, already verified),
  - date = trip date of that day when the trip has dates,
  - mode = foot.
- After saving, the user returns to the trip. The day card shows a collapsed tour block (section 10). An existing
  tour can also be attached to a day from its own page ("Zu einer Reise hinzufügen": trip select, day select).

## 3. Input

### 3.1 Places [T3]

```ts
// src/lib/domain/tour.ts
export const TourPoint = z.object({
  key: z.string().max(40),          // "osm:n123", "osm:w456", "geo:2761369" (GeoNames), "gfy:<place_id>"
  name: z.string().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  source: z.enum(["osm", "geonames", "geoapify"]),
  cat: z.string().max(40).optional(), // OSM category for the icon, e.g. "place_of_worship"
  dwellMin: z.number().int().min(0).max(480).optional(),  // absent = tour default
});
export const MAX_TOUR_PLACES = 10;   // + start + end = at most 12 points
```

Sources, cheapest first:
1. **Suggestions from the cache**: `getInterestGroups` for `general` (plus the linked trip's purpose interests)
   around the city anchor at the standard city radius, `overpass: "cache_only"` + Geoapify fast path (the option from
   `port-places.md` §2). Same cache keys as a city trip to that town, so usually 0 calls.
2. **Search**: new `GET /api/places/search?q=&lat=&lon=&lang=` backed by **Geoapify Autocomplete** (same key and
   quota guard as Places, 1 credit per request). `filter=circle:<city>,20000`, `bias=proximity`, debounced 400 ms,
   minimum 3 characters, 8 results; results with OSM identity get an `osm:` key. Cached per normalized query + city
   cell (2 decimals) + lang, 30 days. Rate limit 30/min and 200/day per user.
3. Towns for start or end (Open-Meteo, `geo:` key).

The browser never supplies coordinates: the server resolves a key it handed out (cache read by key) before saving.

### 3.2 Tour settings

```ts
export const TOUR_MODES = ["foot", "wheelchair", "cycling", "car"] as const;
export const ROUTE_OPTIONS = ["fastest", "shortest", "green", "quiet", "no_steps", "no_highways"] as const;
export const TourInput = z.object({
  title: z.string().trim().max(120).optional(),
  city: TourPoint.optional(),
  places: z.array(TourPoint).min(2).max(MAX_TOUR_PLACES),
  start: TourPoint.optional(),
  end: z.union([z.literal("start"), TourPoint]).optional(),   // absent = open end
  order: z.enum(["optimize", "keep"]).default("optimize"),
  mode: z.enum(TOUR_MODES).default("foot"),
  route: z.enum(ROUTE_OPTIONS).default("fastest"),            // refine: allowed for mode (section 5)
  legOverrides: z.record(z.string(), z.object({ mode: z.enum(TOUR_MODES), route: z.enum(ROUTE_OPTIONS) })).optional(),
  date: IsoDate.optional(),
  startTime: HhMm.optional(),
  endBy: HhMm.optional(),                                      // needs startTime
  minMin: z.number().int().min(15).max(1440).optional(),
  maxMin: z.number().int().min(15).max(1440).optional(),       // refine: minMin <= maxMin
  dwellDefaultMin: z.number().int().min(0).max(240).default(30),
});
```

- **Leg overrides [T7]** are keyed by the place pair `"<fromKey>><toKey>"`. They survive a re-order as long as the
  two places stay neighbours; otherwise they are dropped and the UI says so once ("2 Abschnittseinstellungen
  entfallen, weil sich die Reihenfolge geändert hat").
- **Dwell [T9]**: tour default 30 min, labelled "deine Schätzung" in the form and result. Per place it can be set
  from 0 to 8 h. It is never derived from data and never shown as a fact.
- Effective max = the smaller of `maxMin` and `endBy − startTime`.

## 4. Ordering [T6]

`src/lib/tour/order.ts` (pure):

```ts
export function orderTour(
  m: (number | null)[][],              // seconds, n × n, index = point index
  opts: { start?: number; end?: number; keep?: boolean },
): { order: number[] } | { error: "unreachable"; pairs: [number, number][] };
```

- **Matrix**: one ORS matrix request over all points, profile of the tour mode, durations only
  (`src/lib/server/tour/matrix.ts`). Matrix calls take no `preference` or weightings, so the order is optimal for the
  mode's default routing, not for the chosen route option or per-leg modes. The UI help text says so.
- **Algorithm**: exact Held–Karp DP for an open path, at most 12 points (≈ 600k steps, < 50 ms). Cases:
  - start and end set: fixed path start → end; end = start: round trip;
  - only start: open end; only end: free start;
  - neither: best open path over all starts.
  - Ties broken by input order, so the result is deterministic.
- **"Meine Reihenfolge"** skips the matrix and the DP and uses the input order (start first, end last).
- **Unreachable pairs** (null in the matrix, ORS error 2010 "point not routable" for a place): the place is flagged
  "mit diesem Verkehrsmittel nicht erreichbar" and the tour is not computed until the user removes it or changes the
  mode. Never guessed.
- **Opening hours [T11]**: not used for ordering in the MVP. OSM `opening_hours` is often missing or outdated, and a
  correct parser is a dependency of its own (`opening_hours.js` is LGPL-3.0, to be checked). When a place carries
  the tag, the stop row shows it raw with "laut OpenStreetMap, geprüft am …". Phase 2 can add per-stop time windows
  (DP with earliest finish time, which stays exact when waiting is allowed).
- Alternative considered: ORS `/optimization` (VROOM) solves TSP with time windows in one call, but adds an endpoint,
  a quota and a black box; code is enough for 12 points.

## 5. Routes per leg [T4] [T5] [T8]

### 5.1 Profiles

| Mode | ORS profile | Note |
|---|---|---|
| `foot` | `foot-walking` | default |
| `wheelchair` | `wheelchair` | avoids steps by profile; incline/kerb parameters later |
| `cycling` | `cycling-regular` | `cycling-electric` later |
| `car` | `driving-car` | no traffic, no parking time |

Public transport is not offered: ORS has none, and a transit time would be invented.

### 5.2 Route options, defined by what ORS really does

| Option | Modes | ORS request | What it means (UI help text) |
|---|---|---|---|
| `fastest` | all | `preference: "fastest"` | shortest time according to OSM road data |
| `shortest` | all | `preference: "shortest"` | shortest distance |
| `green` | foot | `preference: "recommended"`, `options.profile_params.weightings.green: 1` | prefers ways through or along parks, trees and other vegetation (ORS green index from OSM land use) |
| `quiet` | foot, cycling | `preference: "recommended"`, `options.profile_params.weightings.quiet: 1` | avoids ways along busy roads (ORS noise index from OSM road classes) |
| `no_steps` | foot | `options.avoid_features: ["steps"]` | no stairs (pram, luggage) |
| `no_highways` | car | `options.avoid_features: ["highways"]`, `preference: "recommended"` | no motorways |

Every request also sets `avoid_features` `"ferries"` (ferry times are not schedules), `geometry: true`,
`instructions: false`, `elevation: false`, `units: "km"`.

**"Most scenic" is not offered under that name.** ORS has no scenic weighting, and OSM has no "beautiful" tag. The
closest honest options are `green` and `quiet` for walking and cycling, and `no_highways` for the car. They are
labelled by what they do ("Grüner", "Ruhiger", "Ohne Autobahn"), never "schöner".
- **Waterfront is not in the MVP.** ORS cannot weight it. The data-backed way would be phase 2: per leg, ORS
  `alternative_routes` (only for 2 waypoints, so one request per leg) and code scoring of each alternative by the
  share of its geometry within 50 m of `waterway=river|canal` or `natural=water` (one Overpass corridor query per
  tour, cached). Cost: up to 1 Directions request per leg plus Overpass load, against the 200/day ORS cap.
- **Coverage is unknown.** The ORS green and noise indices may exist only for some regions (originally Germany).
  The spike (section 14) checks Wien and Passau. An option ORS rejects is hidden ([T5] note); one with a small
  effect stays.

### 5.3 Requests

- Legs are grouped into **runs** of consecutive legs with the same mode and option. One Directions request per run,
  with all its waypoints (ORS allows up to 50, so at most 12 here). A tour without overrides costs **one** request.
  The response's `segments[i]` give each leg's `duration`/`distance`; `way_points` split the encoded polyline per
  leg.
- New client functions in `src/lib/integrations/openrouteservice.ts`, next to the unchanged car functions:
  `fetchMatrixFull(profile, points)` (n × n, durations) and `fetchRoute(profile, points, routeOption)` returning
  `{ legs: { min: number; km: number; poly: string }[] }`. `MAX_DRIVE_MIN` does not apply. "No route" (2009) and
  "not routable" (2010) are answers for the affected leg or place; 429, 5xx and timeouts are failures.
- Polyline decoding (precision 5) is a small pure function in `src/lib/tour/polyline.ts`.

## 6. Sights near the route [T12]

- Candidates: the same cached city places as the suggestions (3.1, no Overpass inline), minus places in the tour.
- Code computes the straight-line distance of each candidate to the decoded route polylines (point-to-segment,
  equirectangular, enough at city scale). Kept within the corridor: foot and wheelchair 150 m, cycling 300 m, car
  1 km. Each is assigned to its nearest leg. At most 3 per leg and 8 per tour, ranked by the existing `rankCandidates`
  order.
- Shown as chips: name, "120 m vom Weg (Luftlinie)", OSM source and check date. No detour time is shown: it would be
  an estimate. "+ hinzufügen" puts the place into the tour, and the next computation gives the real time.
- When the city places are not cached yet, the section says "Orte in der Nähe werden geladen" and enqueues the
  existing place retry job (`place_retries`) for the anchor. The tour itself never waits for sights.

## 7. Time checks [T10]

`src/lib/tour/timing.ts` (pure): total = Σ leg minutes + Σ dwell. With a start time every stop gets arrive and leave
times.

| Situation | Behaviour |
|---|---|
| no limit set | total shown, nothing judged |
| total ≤ max and ≥ min | badge "passt" |
| total > effective max | badge "{n} Min. zu lang". Code proposes up to 3 options using the cached matrix (0 API calls): drop one place (each tried, best saving first), shorten dwell to the default, or switch to "Beste Reihenfolge" when "Meine" is set. Each shows the new total, labelled "ca." because it uses matrix times. Nothing is dropped automatically. |
| total < min | badge "noch {n} Min. frei"; the nearby sights are shown expanded |
| date + start time, and the tour ends after sunset (`suncalc` at the tour's centre) | warning "Endet nach Sonnenuntergang ({time})" |
| a leg failed | no total; the leg row says why |

## 8. Map [T13]

There is **no map component** today (no map library in `package.json`, no CSP to adjust).

- **Web: MapLibre GL JS** (BSD-3) with **OpenFreeMap** vector tiles (free, no key, no request quota; attribution
  "© OpenMapTiles © OpenStreetMap contributors"). `src/components/tour/tour-map.tsx`, a client component loaded with
  `next/dynamic` only on tour views (about 220 kB gz, so no other page pays for it). It draws the leg lines (dashed
  for an override mode), numbered markers and sight dots. The list stays the primary view; when tiles fail, the map
  collapses with "Karte nicht verfügbar".
- Privacy: the viewer's browser loads tiles from OpenFreeMap. The privacy text must list it.
- **PDF and fallback: an SVG route sketch** drawn by code from the stored polylines (react-pdf `Svg`; the same
  geometry as a plain SVG on the web), no base map.
- **"In Google Maps öffnen"**: `https://www.google.com/maps/dir/?api=1&origin=…&destination=…&waypoints=…&travelmode=walking|bicycling|driving`,
  split into two links beyond 9 waypoints. The label says Google may route differently.
- Alternatives: Leaflet (BSD-2, 42 kB) with OSM Foundation raster tiles (tile policy allows light use only, no SLA,
  can be withdrawn); MapTiler or Stadia free tiers (key, monthly caps, non-commercial terms); SVG only (no streets).

## 9. Data model, RLS, sharing [T1] [T14] [T15] [T18]

Migration `supabase/migrations/<date>120039_city_tours.sql` (next free number), forward-only, additive.

### 9.1 `city_tours`

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK; `unique (id, owner_id)` |
| `owner_id` | uuid | no | `auth.uid()` | FK `auth.users` on delete cascade |
| `title` | text | yes | | `<= 120` |
| `input` | jsonb | no | | `TourInput` (3.2), validated by Zod; `pg_column_size(input) <= 16384` |
| `trip_id` | uuid | yes | | composite FK `(trip_id, owner_id) → trips (id, owner_id) on delete set null (trip_id)` (column list, PG 15+) |
| `trip_day` | smallint | yes | | `between 1 and 60`; ignored by code when `trip_id` is null |
| `result` | jsonb | yes | | `TourResult` (9.2), written by the server only |
| `result_hash` | text | yes | | sha256 of the normalized input that produced `result` |
| `computed_at` | timestamptz | yes | | |
| `created_at`, `updated_at` | timestamptz | no | `now()` | `private.set_updated_at()` trigger |

- Indexes: `(owner_id, updated_at desc)`; `(trip_id, trip_day) where trip_id is not null`.
- Cap: 50 tours per owner (count in the action, as for trips).
- Grants: `select, delete` to `authenticated`; `insert (title, input, trip_id, trip_day)` and
  `update (title, input, trip_id, trip_day)`. **`result`, `result_hash`, `computed_at` are not user-writable**:
  the server writes them with the secret key after reading the row through RLS (the `group_parsed` pattern), so a
  direct PostgREST call cannot put a fake "verified" route on a share page.
- Policies (owner): select, insert, update, delete with `owner_id = (select auth.uid())`.
- Policy (grantee, read-only): select with `trip_id = any ((select private.shared_trip_ids()))`. A tour linked to a
  shared trip is visible like the trip's group and purpose: read-only, at every access level.
- Trip deleted (by the user or by `private.purge_expired_trips`): the FK sets `trip_id` null and the tour stays as a
  standalone tour. A new step in the nightly purge deletes standalone tours 18 months after the later of
  `input->>'date'` and `updated_at`, the same span as trips.
- `trip_day` beyond the trip's length (trip shortened later): the tour stays linked, the trip page lists it under
  "Ohne Tag", and it is not sent to the plan.

### 9.2 `TourResult` (snapshot)

```ts
export const TourResult = z.object({
  v: z.literal(1),
  order: z.array(z.string()),                  // point keys, start first
  legs: z.array(z.object({
    from: z.string(), to: z.string(),
    mode: z.enum(TOUR_MODES), route: z.enum(ROUTE_OPTIONS),
    min: z.number().int().min(0).nullable(), km: z.number().min(0).nullable(),
    poly: z.string().max(20000).nullable(),    // encoded polyline, precision 5
    s: z.enum(["ok", "no_route", "not_routable", "failed"]),
  })),
  totalMin: z.number().int().nullable(),
  fit: z.enum(["none", "ok", "over", "under"]),
  sunset: z.string().optional(),               // HH:MM local, only when the tour ends after it
  sights: z.array(z.object({ key: z.string(), name: z.string(), lat: z.number(), lon: z.number(),
    leg: z.number().int(), m: z.number().int(), cat: z.string(), url: z.string().optional() })).max(8),
  source: z.object({ ors: z.string(), osm: z.string().optional() }),   // oldest fetchedAt ISO per provider
  stale: z.boolean().optional(),
});
```

Share views and the PDF read only this snapshot: no external call on the public path.

### 9.3 Sharing

- **MVP**: no own sharing. Tours are visible through a shared trip (9.1), read-only, also to write grantees. A write
  grantee cannot link their own tour to someone else's trip (the composite FK requires the same owner), and the day
  card action is owner-only.
- **Phase 2**: `tour_shares` exactly like `trip_shares` (`share_resource` gains `'tour'`, `private.shared_tour_ids()`,
  `writable_tour_ids()`), and a public link for a standalone tour (`share_links.tour_id`, exactly one of
  `trip_id`/`tour_id` set). This needs the CLAUDE.md rule 6 table list extended (Alex's approval).

## 10. Trip day link, share page, PDF [T16]

**Day card.** At render time (like fixed items, `timed-items.md` [D7]) a linked tour becomes one block in its day:
"Stadttour · 10:00–13:40 · 5 Orte · 4,2 km zu Fuß", expandable to the ordered stop names, the SVG sketch and "Tour
öffnen". With a start time it is placed by the fixed-item merge rule; without one it goes at the top of the day.
Several tours on a day are listed in start order.

**Plan input, without a prompt change.** A linked tour **with a start time** and a computed result enters
`INPUT.fixed` as `{ day, from: startTime, to: startTime + totalMin, cat: "activity", title }` (title cut to 60
characters as for items, `"Stadttour: Stephansdom, Hofburg, …"`). Rule 13 and the overlap guard (timed-items [D6])
then keep that time free. A tour without a start time is shown but not sent; the block says "Startzeit setzen, damit
der Plan diese Zeit freihält". The input hash includes `fixed`, so a changed tour shows the plan as outdated (the
"items changed" hint of timed-items [D8] also checks `city_tours.updated_at`).

**Duplicate guard.** A plan ref on that day whose OSM key is a stop of the day's tour is replaced by its first valid
alt or dropped (`tour_duplicate` in the logged issues), in `assembleDay` next to the stop-ref guard.

**Share link and PDF of a trip.** Linked tours render in their day from the snapshot, with or without
`include_items`. Start and end are shown by name like every stop; when either is a Geoapify address result (no OSM
POI), the share box notice adds "Start und Ende deiner Stadttouren sind sichtbar". PDF: block + SVG sketch; the
sources line adds "Routen: © openrouteservice.org". A standalone tour has no PDF and no link in the MVP.

## 11. Server pipeline, caching and quotas [T17]

`computeTour(id)` in `src/lib/server/tour/compute.ts` (server action, user session):
1. Load through RLS; owner only (grantees read). Zod-parse `input`.
2. Hash the normalized input (points rounded to 5 decimals, options, overrides, date, times). Equal to
   `result_hash` → return the stored result.
3. Rate limit: 10/min in memory, 20 computations per user per Berlin day (count of `tour.computed` events).
4. ORS gate: `orsRequestsLeft() >= 1 + runs + ORS_PLAN_RESERVE` (50, as the drive search). Else `ors_unavailable`;
   a stored result stays shown with "nicht neu berechnet".
5. Matrix (skipped for "keep"), order, routes per run, sights (cache + Geoapify fast path only), timing.
6. Write `result`, `result_hash`, `computed_at` with the secret key; event `tour.computed`.

| Call | Cache key | TTL | Cold cost per computation |
|---|---|---|---|
| ORS matrix | `cacheKey("tour-matrix", 1, { profile, h })`, h = sha256 of sorted `key@lat,lon` (5 dp) | 90 d | 1 request (none with "keep") |
| ORS directions | `cacheKey("tour-route", 1, { profile, route, h })`, h = sha256 of the ordered points | 90 d | 1 per run, usually 1 |
| Geoapify autocomplete | `cacheKey("autocomplete", 1, { q, cell, lang })` | 30 d | 1 credit per uncached query |
| City places | existing interest keys | existing | usually 0 |

- A typical tour costs 2 ORS requests cold and 0 when recomputed unchanged. Adding a place costs 2 again (new
  point set). Routes are cached across users: keys hold public points only, no owner.
- **The ORS cap is shared.** `ORS_DAILY_REQUESTS` (default 200) counts matrix and Directions together for plans,
  drive searches and now tours. Directions measured 200/24 h in the response headers, matrix 500. Proposal: split
  the counter by endpoint (`api_calls.endpoint`: matrix cap 450, directions cap 180) so tours and plans do not use
  each other's budget. Whether ORS counts quotas per profile is a spike question.
- Failures: ORS down with a cached value → served `stale: true` with the stale pill; with no value, the legs are
  `failed` and the tour shows no total. Never a guessed time.
- Logging: every call → `api_calls` (through `cached()`); `tour.created`, `tour.computed { points, mode, route,
  runs, cacheHits, fit, failedLegs }`, `tour.linked`, `tour.sight_added` → `app_events` (no names, no
  coordinates). Admin "Usage" gains tours created and computed per week.

## 12. i18n (namespace `tours`, de + en, same keys)

`tours.{title, newTour, listTitle, empty, defaultTitle, city, cityHint, places, placesSearch, placesHint,
suggestions, suggestionsLoading, addPlace, removePlace, maxPlaces, moreOptions, start, startNone, end, endSame,
endOther, endNone, mode, modes.{foot,wheelchair,cycling,car}, route, routes.{fastest,shortest,green,quiet,no_steps,
no_highways}, routeHelp.{fastest,shortest,green,quiet,no_steps,no_highways}, orderLabel, order.{optimize,keep},
orderHelp, date, startTime, endBy, minDuration, maxDuration, dwellDefault, dwell, dwellEstimate, plan, replan,
outdated, computing, summary, total, distance, fit.{ok,over,under}, sunset, legChange, legSheetTitle,
overridesDropped, nearby, nearbyDistance, nearbyAdd, unreachable, legFailed, noRoute, suggestionsTitle,
suggest.{drop,dwell,optimize}, approx, openingHoursOsm, mapUnavailable, openGoogle, openGoogleNote, sources,
checked, stale, notRecomputed, walkNote, addToTrip, tripSelect, daySelect, noDay, dayBlock, dayBlockNoTime, openTour,
dayAction, errors.{ors_unavailable, rate_limited, daily_limit, limit_reached, not_found, forbidden, failed}}`, plus
`share.tourEndpointsVisible`, `admin.usage.{toursCreated, toursComputed}` and the privacy text line for OpenFreeMap.
`walkNote` is the footer: "Zeiten aus OpenStreetMap-Wegdaten, ohne Wartezeiten, Ampeln oder Andrang."

## 13. Tests

No LLM, so no evals. CI needs no network: ORS and Geoapify answers are recorded in the spike.
- **Pure units**: `orderTour` against brute force on random 8-point matrices (all start/end cases, keep order,
  ties); unreachable pairs; `timing` (fit cases, effective max from `endBy`, arrive/leave times, sunset with suncalc
  for Wien in December); drop proposals; polyline decode and point-to-polyline distance; corridor filter and per-leg
  cap; run grouping from overrides; override keys surviving or dropped on re-order; Google link builder (split
  beyond 9); input hash stable under key order; `TourInput` refines (route allowed per mode, `minMin <= maxMin`,
  `endBy` needs `startTime`).
- **Clients** (recorded fixtures, Wien and Passau): matrix foot-walking; directions with 6 waypoints and segments;
  `green`, `quiet`, `no_steps`, `no_highways`; 2009 and 2010 bodies; autocomplete body.
- **Server**: unchanged input → no ORS call; gate below reserve → `ors_unavailable` with no call; one run = one
  Directions request; sights never trigger Overpass; `result` written with the secret key only after an RLS read.
- **Plan**: a linked tour with start time appears in `fixed` as `activity`; without start time it does not; the
  duplicate guard replaces a ref by its alt; golf, cruise and Würzburg inputs stay byte-identical without tours.
- **pgTAP** (`supabase/tests/city-tours.test.sql`): B cannot read A's tours; C (grantee of A's trip) reads the
  linked tour, cannot update or delete it, and cannot read A's unlinked tours; `authenticated` cannot update
  `result`; linking to another owner's trip fails (FK); deleting the trip keeps the tour with `trip_id` null and
  `owner_id` intact.
- **UI**: 360 px screenshots of the form, the result list with a leg sheet, and the day block; the `de` and `en` keys
  match.

## 14. Phasing

| Phase | Content |
|---|---|
| 0 spike | integrations-dev, about 12 live ORS calls (free): matrix foot-walking for 6 Wien points (limits, latency); Directions foot-walking with 6 waypoints (segments, way_points, polyline); `green` and `quiet` weightings in Wien and Passau (accepted? route differs? coverage); `extra_info: ["green", "noise"]` presence; `no_steps`; wheelchair; cycling-regular; driving-car `no_highways`; `x-ratelimit-*` headers per endpoint and profile; one Geoapify autocomplete call ("Stephansdom" around Wien). Result recorded in this spec, as in `find-destinations-drive.md` §5. |
| 1 MVP | sections 2–13: standalone tours, 4 modes, route options that pass the spike, per-leg overrides, order optimize/keep, start/end, dwell, min/max/end-by, drop proposals, sunset warning, sights near the route, MapLibre map, trip-day link with `fixed` slot and duplicate guard, trip share page and PDF block. PRs: migration first (alone), then server, then UI. |
| 2 | `tour_shares` and a public tour link, standalone tour PDF; per-stop time windows; opening hours parsed for checks; waterfront option via alternative routes; paste a list of places (code split + autocomplete each); weather forecast for the tour date (Open-Meteo, within 16 days); e-bike profile; "use my location" as start. |

## 15. Decisions (accepted by Alex, 2026-11-12)

- **[T1] Own resource `city_tours`, points and settings as jsonb, optional link `(trip_id, trip_day)` to an own trip
  (composite FK, `on delete set null (trip_id)`).** *Recommended:* a tour lives on its own and keeps the user's work
  when the trip is deleted. Alternatives: tours as trip items (no standalone tours), a separate `tour_points` table
  (more joins for at most 12 rows), cascade delete with the trip.
- **[T2] No LLM step.** *Recommended:* ordering, timing, labels and titles are code; no allowed-use line is added to
  rule 2. If Alex ever wants one, the narrowest line would be "Haiku turns a pasted list of place names into search
  terms" — not needed, because code can split a list.
- **[T3] Places from cached city places plus a new Geoapify Autocomplete search.** *Recommended:* same key and quota
  guard as Places, returns OSM ids, autocomplete is allowed by its terms. Alternatives: Photon (komoot, free, fair
  use, no SLA), Nominatim (usage policy forbids autocomplete), Open-Meteo only (towns, no sights).
- **[T4] Four modes on ORS profiles `foot-walking`, `wheelchair`, `cycling-regular`, `driving-car`; no public
  transport.** *Recommended.* Alternatives: foot only in the MVP; add `cycling-electric` now.
- **[T5] Route options named by what ORS does (`fastest`, `shortest`, `green`, `quiet`, `no_steps`, `no_highways`);
  no "scenic" label; waterfront only in phase 2 by scored alternatives.** *Recommended:* honest and one request per
  run. Alternatives: label `green` as "scenic" (overpromises); build waterfront scoring now (≈ 1 request per leg plus
  Overpass).
  **Alex (2026-11-12):** accepted, and the six options are offered in the app under exactly these honest labels
  (de "Schnellste", "Kürzeste", "Grüner", "Ruhiger", "Ohne Treppen", "Ohne Autobahn"; en "Fastest", "Shortest",
  "Greener", "Quieter", "No steps", "No motorways"), each with its help text from 5.2. The spike only hides an option
  that ORS rejects for a profile; an accepted option stays even where its effect is small, and the help text says
  that the effect depends on the OpenStreetMap data of the area.
- **[T6] Exact Held–Karp TSP in code over one ORS matrix, optional fixed start/end, "Meine Reihenfolge" option.**
  *Recommended:* deterministic, testable, no extra endpoint. Alternative: ORS `/optimization` (VROOM), worth it only
  with per-stop time windows.
- **[T7] Per-leg overrides keyed by place pair; the order uses the tour mode only.** *Recommended.* Alternatives:
  overrides by leg index (lost on every re-order), per-leg modes inside the optimization (a matrix per mode).
- **[T8] One Directions request per run of legs with equal options.** *Recommended:* a plain tour costs 1 request.
  Alternative: one request per leg (simpler, up to 11× the quota).
- **[T9] Dwell: tour default 30 min plus per-place values, always labelled as the user's estimate.** *Recommended.*
  Alternatives: default 0 (time checks become meaningless), category defaults (an invented fact).
- **[T10] Over the limit: code proposes drop/shorten/optimize options and never drops by itself; under: show sights;
  sunset warning via suncalc.** *Recommended.* Alternative: drop the cheapest places automatically.
- **[T11] Opening hours not used in the MVP; the raw OSM tag is shown with its source.** *Recommended:* data quality
  and parser licence. Alternative: parse with `opening_hours.js` (LGPL-3.0) and warn on conflicts.
- **[T12] Sights from cached city places, filtered by a corridor around the route in code (150 m foot, 300 m bike,
  1 km car), no inline Overpass.** *Recommended:* usually 0 calls, cache shared with trips. Alternative: one Overpass
  `around` query along the polyline per tour (25–60 s, load on a shared service).
- **[T13] MapLibre GL JS + OpenFreeMap tiles, lazy-loaded; SVG sketch in the PDF; Google Maps deep link.**
  *Recommended:* free, no key, no quota. Alternatives: Leaflet + OSM raster tiles (tile policy), MapTiler/Stadia
  (key, caps), SVG only.
- **[T14] `result` is a snapshot written only by the server with the secret key.** *Recommended:* share pages need
  no external calls, and users cannot fake verified data. Alternative: user-writable like the other columns
  (simpler, weaker).
- **[T15] MVP sharing only through a shared trip (read-only); `tour_shares` and a public tour link in phase 2.**
  *Recommended:* no new share table now. Alternative: full sharing in the MVP (another `share_resource` branch,
  rule 6 change).
- **[T16] A linked tour with a start time enters the plan as a `fixed` `activity` slot; no prompt change; a code
  guard drops duplicate refs on that day.** *Recommended.* Alternatives: a new `cat: "tour"` with its stop names
  (prompt bump, more tokens); no plan input at all (the plan may fill the same hours twice).
- **[T17] ORS gate with the 50-request plan reserve, 20 computations per user per day, 90-day caches; split the ORS
  cap by endpoint.** *Recommended.* Alternative: keep the one shared 200 counter (tours and drive searches compete
  for Directions).
- **[T18] Caps: 10 places + start + end, 50 tours per user; standalone tours purged 18 months after the later of
  date and last change.** *Recommended.* Alternatives: 8 places (shorter lists on phones), no retention.
- **[T19] Spike first, then MVP as section 14, phase 2 after use.** *Recommended.*

## 16. Risks and unknowns

- ORS green and noise data may not cover Wien (or be missing on the public API); then `green`/`quiet` are hidden and
  walking tours offer only `fastest`, `shortest` and `no_steps`.
- The Directions quota (measured 200/24 h) is shared with drive searches and plans; a busy day can block tours.
- OpenFreeMap is a donation-run service without an SLA; the list and the SVG sketch must stay fully usable without
  it.
- ORS walking times assume a constant speed and ignore crowds, crossings and lifts; the footer says so.
- A Geoapify autocomplete result without OSM identity cannot be matched to plan places for the duplicate guard.
