# City tour: places in, tour out (issue #172)

Status: decided (Alex, 2026-11-12: all recommendations T1–T19 accepted; T5 with the note below). ADR:
`docs/adr/0012-city-tours.md`.

Alex's request (#172): "Plan a city tour from a few places the user names. The tool orders them into a sensible tour
and plans the legs between them." Wanted: route choice per tour or per leg (fastest, most scenic, ...), verified
sights on or near the way, time limits (tour and per stop), standalone or part of a trip (for example one day of the
plan).

Scope: one tour = one city, up to 25 places (10 in the MVP, 17.1 [P1]) plus an optional start and end, one day, walking, wheelchair, bike or
car. Not in scope: public transport (ORS has none), multi-day tours, booking, live navigation.

Examples use the fixture towns only: Wien (Stephansdom, Hofburg, Naschmarkt, Belvedere, Riesenrad) and Passau (Dom
St. Stephan, Veste Oberhaus, Ortspitze, Rathaus).

---

## 1. Principles applied

- **Ground rule 1.** Order, leg times, distances, geometry and nearby sights come from ORS, OSM (Geoapify/Overpass
  cache) and code. Nothing in a tour is written by a model.
- **Ground rule 2.** Ordering is a small exact TSP in code over one ORS matrix. Timing is arithmetic. **No LLM step
  [T2]**: there is no judgment or prose the user needs that code cannot give. The title defaults to code text
  ("Wien", or "Stadttour ab Hofburg" without a city; the stop count is on the line below, issue #212).
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
  key: z.string().max(160),         // MAX_POINT_KEY; "osm:n123", "osm:w456", "geo:2761369" (GeoNames), "gfy:<place_id>"
  name: z.string().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  source: z.enum(["osm", "geonames", "geoapify"]),
  cat: z.string().max(40).optional(), // OSM category for the icon, e.g. "place_of_worship"
  dwellMin: z.number().int().min(0).max(480).optional(),  // absent = tour default
});
export const MAX_TOUR_PLACES = 25;   // + start + end = at most 27 points (was 10 in the MVP, section 17.1 [P1])
```

Sources, cheapest first:
1. **Suggestions from the cache** (changed by the landmark fix, see "Implementation notes (landmarks)"): the city's
   landmarks by prominence, then the linked trip's purpose interests. Originally: `getInterestGroups` for `general` (plus the linked trip's purpose interests)
   around the city anchor at the standard city radius, `overpass: "cache_only"` + Geoapify fast path (the option from
   `port-places.md` §2). Same cache keys as a city trip to that town, so usually 0 calls.
2. **Search** (landmarks matched first since the landmark fix): new `GET /api/places/search?q=&lat=&lon=&lang=` backed by **Geoapify Autocomplete** (same key and
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
): { order: number[]; exact: boolean } | { error: "unreachable"; pairs: [number, number][] };   // opts also take quick?: boolean
```

- **Matrix**: one ORS matrix request over all points, profile of the tour mode, durations only
  (`src/lib/server/tour/matrix.ts`). Matrix calls take no `preference` or weightings, so the order is optimal for the
  mode's default routing, not for the chosen route option or per-leg modes. The UI help text says so.
- **Algorithm**: exact Held–Karp DP for an open path up to 16 points (`EXACT_MAX_POINTS`); above that the deterministic
  local search of `order-heuristic.ts` with `exact: false` (17.1 [P1]); `quick` (drop proposals) is exact only up to
  12 points. Cases:
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
  a quota and a black box; code is enough for 27 points (17.1 [P1]).

## 5. Routes per leg [T4] [T5] [T8]

### 5.1 Profiles

| Mode | ORS profile | Note |
|---|---|---|
| `foot` | `foot-walking` | default |
| `wheelchair` | `wheelchair` | avoids steps by profile; incline/kerb parameters later |
| `cycling` | `cycling-regular` | `cycling-electric` later |
| `car` | `driving-car` | no traffic, no parking time |

Public transport is not offered: ORS has none, and a transit time would be invented. Phase 2 may add it per leg from timetable data (section 17.1 [P3]).

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
`instructions: true` (ORS returns `segments` only with instructions; the client drops `steps`, spike 2026-11-12),
`elevation: false`, `units: "km"`. Weightings are plain numbers (`green: 1`); the `{ factor }` form from the ORS docs
is rejected. Exact bodies: section 14, spike results.

**"Most scenic" is not offered under that name.** ORS has no scenic weighting, and OSM has no "beautiful" tag. The
closest honest options are `green` and `quiet` for walking and cycling, and `no_highways` for the car. They are
labelled by what they do ("Grüner", "Ruhiger", "Ohne Autobahn"), never "schöner".
- **Waterfront is not in the MVP.** ORS cannot weight it. The data-backed way would be phase 2: per leg, ORS
  `alternative_routes` (only for 2 waypoints, so one request per leg) and code scoring of each alternative by the
  share of its geometry within 50 m of `waterway=river|canal` or `natural=water` (one Overpass corridor query per
  tour, cached). Cost: up to 1 Directions request per leg plus Overpass load, against the app's Directions cap.
- **Coverage (spike 2026-11-12).** The ORS green and noise indices exist in Germany (Passau) but not in Austria
  (Wien: fill values, same route as `fastest`). ORS accepts every option of this table for its modes, so all stay
  ([T5] note); the help text says the effect depends on the area's OpenStreetMap data.

### 5.3 Requests

- Legs are grouped into **runs** of consecutive legs with the same mode and option. One Directions request per run,
  with all its waypoints (ORS allows up to 50, so at most 27 here). A tour without overrides costs **one** request.
  The response's `segments[i]` give each leg's `duration`/`distance`; `way_points` split the encoded polyline per
  leg.
- New client functions in `src/lib/integrations/openrouteservice.ts`, next to the unchanged car functions:
  `fetchMatrixFull(profile, points)` (n × n, durations) and `fetchRoute(profile, points, routeOption)` returning
  `{ legs: { min: number; km: number; poly: string }[] }`. `MAX_DRIVE_MIN` does not apply. "No route" (2009) and
  "not routable" (2010) are answers for the affected leg or place; 429, 5xx and timeouts are failures.
- Polyline decoding (precision 5) is a small pure function in `src/lib/tour/polyline.ts`.

## 6. Sights near the route [T12]

- Candidates: the same cached city places as the suggestions (3.1, no Overpass inline), minus places in the tour.
  Since the landmark fix: the top 60 landmarks of the city by prominence (the order replaces `rankCandidates`).
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
| `input` | jsonb | no | | `TourInput` (3.2), validated by Zod; `pg_column_size(input) <= 32768` (16384 in the MVP; raised for 25 places, 17.1 [P1]) |
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
4. ORS gate: `orsTourGate(runs, { needsMatrix })` from `ors-quota.ts`: matrix bucket `>= 1 + ORS_PLAN_RESERVE` (50;
   skipped with "keep") and Directions bucket `>= runs`. Else `ors_unavailable`; a stored result stays shown with
   "nicht neu berechnet".
5. Matrix (skipped for "keep"), order, routes per run, sights (cache + Geoapify fast path only), timing.
6. Write `result`, `result_hash`, `computed_at` with the secret key; event `tour.computed`.

| Call | Cache key | TTL | Cold cost per computation |
|---|---|---|---|
| ORS matrix | `cacheKey("tour-matrix", 1, { profile, h })`, h = sha256 of sorted `key@lat,lon` (5 dp) | 90 d | 1 request (none with "keep") |
| ORS directions | `cacheKey("tour-route", 1, { profile, route, h })`, h = sha256 of the ordered points | 90 d | 1 per run, usually 1 |
| Geoapify autocomplete | `cacheKey("autocomplete", 1, { q, cell, lang })` | 30 d | 1 credit per uncached query |
| City places | existing interest keys | existing | usually 0 |
| Landmarks (Overpass, warm-up/retry only) | `landmarks:v1:{lat,lon,r=8}` (anchor 3 dp) | 30 d | 1 query per city |
| Landmark sitelinks (Wikidata, warm-up/retry only) | `sitelinks:v1:{lat,lon,r=8}` | 90 d | 1 request per 50 ids, at most 20 |
| Geoapify autocomplete, tour places | `cacheKey("autocomplete", 2, { q, cell, lang, type: "amenity" })` | 30 d | 1 credit per uncached query |

- A typical tour costs 2 ORS requests cold and 0 when recomputed unchanged. Adding a place costs 2 again (new
  point set). Routes are cached across users: keys hold public points only, no owner.
- **The ORS cap is split by endpoint** (built in the clients PR): ORS counts per endpoint (matrix 500, Directions
  2000 per 24 h), shared by all profiles (spike 2026-11-12). `ors-quota.ts` keeps a matrix bucket (`matrix` +
  `tour_matrix`, `ORS_MATRIX_DAILY` 450) and a Directions bucket (`route` + `tour_route`, `ORS_DIRECTIONS_DAILY`
  1800), both counted over the last 24 h; `ORS_DAILY_REQUESTS` is retired. Details in section 14, spike results.
- Place search: `autocompletePlaces` and `placeDetails` (`src/lib/server/facts/place-search.ts`, cached 30 / 90 d).
  Search results carry `key: "gfy:" + 32 hex of sha256(place_id)` plus the `placeId`: a raw `place_id` is 100–200
  characters, above the 40 of `TourPoint.key`.
- Failures: ORS down with a cached value → served `stale: true` with the stale pill; with no value, the legs are
  `failed` and the tour shows no total. Never a guessed time.
- Logging: every call → `api_calls` (through `cached()`); `tour.created`, `tour.computed { points, mode, route,
  runs, cacheHits, fit, failedLegs }`, `tour.linked`, `tour.sight_added` → `app_events` (no names, no
  coordinates). Admin "Usage" gains tours created and computed per week.

## 12. i18n (namespace `tours`, de + en, same keys)

`tours.{title, newTour, empty, defaultTitle, city, cityHint, places, placesSearch, placesHint,
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
| 2 | See section 17 (issue #205, decided 2026-11-13). Original list: `tour_shares` and a public tour link, standalone tour PDF; per-stop time windows; opening hours parsed for checks; waterfront option via alternative routes; paste a list of places (code split + autocomplete each); weather forecast for the tour date (Open-Meteo, within 16 days); e-bike profile; "use my location" as start. |

### Spike results (2026-11-12)

18 live ORS calls (1 matrix, 17 Directions) and 2 Geoapify calls (1 autocomplete, 1 place details), free tiers, on
`api.heigit.org/openrouteservice/v2`, engine **10.1.0** (graph date 2026-11-09; the drive spike saw 9.10.0). Recorded
bodies: `src/lib/integrations/__fixtures__/ors-tour/` and `.../geoapify-autocomplete/` (bodies only; `steps` removed
except in `directions-foot-wien-fastest.json`, the full 6-waypoint body; place-details polygon replaced by its
point). Docs checked: ORS routing options and extra info
(`giscience.github.io/openrouteservice/api-reference/endpoints/directions/…`), Geoapify autocomplete and place
details (`apidocs.geoapify.com/docs/…`), 2026-11-12.

Points. Wien (lon, lat): Stephansdom 16.3731,48.2085 · Hofburg 16.3655,48.2065 · Naschmarkt 16.3630,48.1990 ·
Karlskirche 16.3716,48.1981 · Oberes Belvedere 16.3810,48.1915 · Riesenrad 16.3958,48.2166 (Directions in this
order). Passau: Dom St. Stephan 13.4648,48.5741 · Rathaus 13.4672,48.5746 · Ortspitze 13.4774,48.5737 · Veste
Oberhaus 13.4718,48.5775 (in this order).

| # | Call | HTTP, time | Result |
|---|---|---|---|
| 1 | Matrix `foot-walking`, Wien 6 points, `metrics: ["duration","distance"]` | 200, 0.70 s | 6 × 6 `durations` (s) and `distances` (km), plus `sources`/`destinations` with snapped `location` and `snapped_distance` (10–35 m). Headers `x-ratelimit-limit: 500`, `remaining: 498`. |
| 2 | Directions `foot-walking`, Wien 6 waypoints, fastest, `instructions: false` | 200, 0.21 s | 91 min, 7.56 km, 399 polyline points, `way_points [0,40,124,168,220,398]`. **No `segments` at all**: ORS returns them only with instructions. `x-ratelimit-limit: 2000`. |
| 3 | Same with `instructions: true` | 200, 0.21 s, 15 KB | 5 `segments` with `distance`/`duration` (9, 15, 9, 15, 43 min); they **equal the matrix cells** of #1 to 0.1 s. Each segment carries `steps`; their `way_points` are global polyline indices. |
| 4 | foot, `shortest` | 200, 0.16 s | Accepted. Differs slightly: 7.52 km, 90 min, other geometry (366 points). |
| 5 | foot, `green` as `{ "factor": 1 }` (the docs' example format), Wien and Passau | 400, 2× | **Rejected, code 2002** "Parameter 'options' has incorrect value or format". Same for `quiet` in that format (2×). |
| 6 | foot, `green: 1` (plain number, the 5.2 format), Wien | 200, 0.22 s | Accepted (ORS echoes `"weightings":{"green":1.0}`). **Same geometry as fastest.** |
| 7 | foot, `quiet: 1`, Wien | 200, 0.22 s | Accepted. **Same geometry as fastest.** |
| 8 | foot, `extra_info: ["green","noise"]`, Wien | (in #2, #6, #7) | Present but constant: green 10 and noise 7 over 100 % of the route, through the Innere Stadt. **No green/noise data for Wien** (Austria): the values are fill values, and the weightings have nothing to act on. |
| 9 | foot fastest, Passau | 200, 0.14 s | 24 min, 2.02 km. `extra_info` varies (green 4–10, noise 7–10): data exists in Germany. |
| 10 | foot `green: 1`, Passau | 200, 0.15 s | Accepted. **Same geometry as fastest** on this tour. |
| 11 | foot `quiet: 1`, Passau | 200, 0.20 s | Accepted. **Very different**: 55 min, 4.56 km (fastest 24 min, 2.02 km); Ortspitze → Veste Oberhaus 37 min instead of 11. Share of noise 10 drops from 27 % to 5 %. |
| 12 | foot `avoid_features: ["ferries","steps"]`, Wien | 200, 0.21 s | Accepted. Same geometry as fastest (no steps on these legs). |
| 13 | `wheelchair`, fastest, Wien | 200, 0.35 s | Accepted. 102 min, 8.55 km (foot 91 min, 7.56 km). `extra_info` green/noise "not available" (warning code 4). |
| 14 | `cycling-regular`, `recommended` + `quiet: 1`, Passau 2 points (one near the Danube, radius 10 m) | 200, 0.13 s | Accepted (meant as a 2010 probe, but the point snapped to the riverside path). The quiet weighting is **accepted for cycling** although the docs list it for foot only; its effect on cycling was not measured. green/noise extras "not available". |
| 15 | `driving-car`, `recommended` + `avoid_features: ["ferries","highways"]`, Wien | 200, 0.13 s | Accepted. 32 min, 12.1 km. No car-fastest call to compare (call budget); no motorway lies between these points anyway. |
| 16 | `wheelchair`, `shortest`, Passau + a mid-Inn point with `radiuses: [350, 1]` | 404, 0.12 s | **Code 2010** "Could not find routable point within a radius of 1.0 meters of specified coordinate 1: 13.4650000 48.5712000.; Connection between locations not found". Coordinate index is 0-based. Since 2010 comes after parameter validation, `wheelchair` + `shortest` is accepted. |
| 17 | 2009 (no route) | not called | Already recorded on 2026-11-01 (`openrouteservice/directions-no-route.json`, HTTP 404, same `error.code` + `info` shape). A foot or bike 2009 needs a disconnected island in a fixture town, which does not exist. |
| 18 | Geoapify autocomplete `text=Stephansdom&filter=circle:16.3731,48.2085,20000&bias=proximity:16.3731,48.2085&lang=de&limit=8&format=json` | 200, 0.57 s, 6 KB | `{ results: [...], query: { text } }`, 5 results: Stephansdom (OSM, `result_type: "amenity"`, `distance` 2 m), "Stephansdom Krypta" **twice** (two OSM index entries for the same node), the WhosOnFirst neighbourhood "Stephansdom", a GeoNames hotel. **No `datasource.raw`, no `osm_id`/`osm_type`**: `datasource` has only `sourcename`, attribution and licence. `place_id` encodes the OSM type and id in an undocumented binary hex (checked against the OSM API: way 212496461, node 4543089891). No credit or rate-limit headers. |
| 19 | Geoapify place details `id=<place_id of #18>&lang=de` | 200, 0.68 s | `features[0].properties.datasource.raw` has `osm_type: "w"`, `osm_id: 212496461`, `wikidata: "Q5943"`, `opening_hours`, plus `categories`. 1 credit (docs). |

**Polyline.** Encoded polyline, precision 5, `[lat, lon]` order (2D with `elevation: false`). Leg *i* is the decoded
points `way_points[i] … way_points[i+1]` inclusive (neighbouring legs share the waypoint). Checked: every
`way_points` index decodes to the snapped location of #1. The sum of `segments` equals `summary`.

**Route options the MVP offers (T5: hide only what ORS rejects).**

| Mode (profile) | Options | Note |
|---|---|---|
| `foot` (`foot-walking`) | `fastest`, `shortest`, `green`, `quiet`, `no_steps` | all accepted; in Wien green/quiet/no_steps gave the fastest route, in Passau quiet changed it strongly |
| `wheelchair` (`wheelchair`) | `fastest`, `shortest` | both accepted |
| `cycling` (`cycling-regular`) | `fastest`, `shortest`, `quiet` | `quiet` accepted (#14); fastest/shortest use the same `preference` parameter but were **not called live** for cycling |
| `car` (`driving-car`) | `fastest`, `shortest`, `no_highways` | `no_highways` accepted (#15); fastest/shortest **not called live** for the car |

The first client fixtures of phase 1 record cycling fastest/shortest and car fastest/shortest (4 calls). If one of
them is rejected, it is removed from this list.

**Exact request bodies** (POST `…/v2/directions/<profile>/json`). Common part, every option:

```json
{ "coordinates": [[lon, lat], ...], "geometry": true, "instructions": true, "elevation": false, "units": "km",
  "options": { "avoid_features": ["ferries"] } }
```

| Option | Added to the common part |
|---|---|
| `fastest` | `"preference": "fastest"` |
| `shortest` | `"preference": "shortest"` |
| `green` | `"preference": "recommended"`, `"options": { "avoid_features": ["ferries"], "profile_params": { "weightings": { "green": 1 } } }` |
| `quiet` | `"preference": "recommended"`, `"options": { "avoid_features": ["ferries"], "profile_params": { "weightings": { "quiet": 1 } } }` |
| `no_steps` | `"preference": "fastest"`, `"options": { "avoid_features": ["ferries", "steps"] }` |
| `no_highways` | `"preference": "recommended"`, `"options": { "avoid_features": ["ferries", "highways"] }` |

Matrix (POST `…/v2/matrix/<profile>`): `{ "locations": [[lon, lat], ...], "metrics": ["duration"] }` (#1 also asked
for distances; the order needs durations only).

Consequences for the build:
- **`instructions: true`, not `false`** (5.2 changed). Segments exist only with instructions; the client drops
  `steps` before caching. A 6-waypoint walking tour is about 15 KB on the wire and about 2 KB polyline.
- **Weightings as plain numbers** (`green: 1`). The `{ factor }` objects from the ORS docs are rejected (2002), so a
  client test pins the body.
- **No `extra_info`.** green/noise exist for foot only, are fill values outside Germany, and the scale is not usable
  as a fact. Every foot response carries warning code 4 ("roadaccessrestrictions not available"), which the parser
  ignores.
- The `quiet` effect can be large (Passau +130 % time). It is the user's choice; the leg shows the real minutes. The
  help text says the effect depends on the OpenStreetMap data of the area (T5), and it is mostly none in Austria.
- 2010 is HTTP 404 with `error.code` 2010 and the 0-based coordinate index in the message; the client parses the
  index to flag the place. 400/2002 is a failure (a bug), never an answer.
- Latency: Directions 0.11–0.35 s, matrix 0.7 s, so the client keeps the existing timeouts.
- **Autocomplete has no OSM identity.** Search results get a `gfy:<place_id>` key. When the user **adds** an OSM-sourced
  result, the server resolves it once with place details (1 credit, cached 90 d by `place_id`) to the `osm:` key and
  `cat`. Results from `whosonfirst`/`geonames` stay `gfy:`. Decoding `place_id` would save the credit but is
  undocumented, so it is not used. Results are deduplicated by name + coordinates (5 dp), because the same OSM node
  came back twice.

**Quota (T17).**
- Matrix: `x-ratelimit-limit: 500`. Directions: `x-ratelimit-limit: 2000`. Each endpoint has **its own counter**.
  Within Directions, `remaining` fell by exactly 1 per call across `foot-walking`, `wheelchair`, `cycling-regular` and
  `driving-car`: **one Directions quota shared by all profiles**, not one per profile.
- Rejected requests count: the four 400s (2002) and the 404 (2010) each decremented `remaining`.
- `x-ratelimit-reset` is a fixed 24 h window opened by the first request after the previous window ended: the first
  Directions call of the day reported reset = its own time, all later calls the same value + 24 h. It is neither
  Berlin midnight nor a rolling window. No per-minute header (the plan's 40/min is not exposed).
- The drive spike (2026-11-01) read 200 for Directions; today's headers and `ors-quota.ts` (dashboard) say 2000.
- Geoapify sends no quota headers; autocomplete and place details cost 1 credit each (docs) of the 3,000/day.

**Recommendation for the ORS cap split.** Two counters in `ors-quota.ts`, by ORS endpoint over `api_calls.endpoint`:
- **matrix bucket** = endpoints `matrix` (plans) and `tour_matrix`: cap `ORS_MATRIX_DAILY`, default **450**; the
  plan reserve `ORS_PLAN_RESERVE` (50) applies here, because plans only use the matrix.
- **directions bucket** = endpoints `route` (drive search) and `tour_route`: cap `ORS_DIRECTIONS_DAILY`, default
  **1800**.
- **Count the last 24 h, not since Berlin midnight.** ORS's window starts at an arbitrary time, so a Berlin-day count
  can let two app days fall into one ORS window (up to twice the cap). A rolling 24 h count at or under the cap keeps
  every ORS window under it too.
- Tour gate: `matrixLeft >= 1 + ORS_PLAN_RESERVE` (skip with "keep") and `directionsLeft >= runs`. Drive-search gate:
  `directionsLeft >= 8`. `ORS_DAILY_REQUESTS` is retired; the admin settings `ors_matrix_daily` and
  `ors_directions_daily` replace `ors_daily_requests`. Rows the guard itself refused (`error_code = quota_guard`) are
  not counted, or a rolling window would stay closed while refused attempts keep coming.

### Implementation notes (server PR, 2026-11-12)

**Point resolution (3.1): signed point references.** The browser sends points as `TourPointDraft`
(`{ key, ref?, dwellMin? }`, `TourDraft` in `src/lib/domain/tour.ts`), never coordinates. The server resolves each
key in this order (`src/lib/server/tour/resolve.ts`):
1. **A signed `ref`** (`src/lib/server/tour/point-ref.ts`). Every point the server offers (a cached city place from
   `tourSuggestions`, a result of `/api/places/search`) goes out with `ref` = base64url JSON of the point (key, name,
   coordinates, source, category; for a search result also the Geoapify `place_id` and whether it is an OSM result)
   plus an HMAC-SHA256, valid 24 h. The HMAC key is derived from `SUPABASE_SECRET_KEY` with a fixed label (no new
   secret to provision). The ref must be authentic, unexpired and name exactly that key; every stored value comes
   from the signed payload. An OSM search result is then resolved once to its `osm:` key and category through place
   details (1 credit, cached 90 d); when details fail, or for Who's On First / GeoNames results, the point stays
   `gfy:` with its signed coordinates. Leg overrides are re-keyed when a key changes this way.
2. **A point already stored in the tour** (its input, or a sight of its server-written result), for updates and for
   "+ hinzufügen" on a sight chip.
3. **`geo:<GeoNames id>`** (city, start, end towns): Open-Meteo place by id (cached 365 d), like a trip destination.

Anything else is `unknown_point` (the issues list the keys). Why not a cache lookup by key: the place caches are
keyed by area or query, not by point, and a per-suggestion cache row would cost a write per search. Limit: `input`
stays user-writable over PostgREST (grant), so the owner can store other coordinates on their own tour; the route
computed for them is still real ORS output, and the result itself is server-written only [T14].

**Limits.** Computations: 10/min in memory plus 10/min and 20 per Berlin day per user in `ai_call_slots` (task
`tour_compute`, `reserveAiCall`: atomic across instances; the table holds user, task and time only). The place search
uses the same table with task `place_search` (30/min, 200/day). An unchanged input takes no slot; a slot refused by
the ORS gate is released.

**Deviations and details.**
- A Directions 2010 (`not_routable`) is handled like an unreachable matrix pair (section 4): `unreachable` with the
  point keys, nothing stored. The leg status `not_routable` is therefore not written by the MVP server; `no_route`
  (2009) marks the legs of that run.
- Dropped leg overrides are reported (`droppedOverrides`) but not removed from the stored input; the result hash is
  that of the stored input, so an unchanged recompute does not report them again.
- Drop/dwell/optimize proposals are returned with each computation, not stored in `TourResult`. With "keep" the
  matrix is read from the cache only (`peekTourMatrix`), never fetched.
- An unchanged tour whose stored result has no sights reads the city places from the cache only (0 calls) and adds
  sights that have arrived since (the retry job), with the same hash.
- The secret-key write is scoped to `id`, `owner_id` and the `updated_at` read through RLS; a tour changed meanwhile
  gives `conflict`. The write moves `updated_at` (trigger), so the response carries the new `updatedAt`.
- Sights use `general` around the city (or the first place without a city); suggestions add the linked trip's purpose
  interests. Both use a `city` destination (standard city radius), so they share cache keys with a city trip there.
- Admin "Usage" shows tours created and computed in the last 7 days (`app_events` counts).
- The sunset check needs the city's time zone (Open-Meteo place of the `geo:` city). A tour without a city gets no
  sunset warning even with date and start time: no verified zone, and a guessed local time would be wrong. The UI may
  say the check needs a city.
- A stored result with a `failed` leg is recomputed even when the input is unchanged (an outage is not kept).
- `updateTour` with `expectedUpdatedAt` is a conditional update; a concurrent save in between gives `conflict`.

### Implementation notes (UI PR, 2026-11-12)

- **Pages.** `/app/tours` (own tours), `/app/tours/new` (`?trip=&day=` prefill by `src/lib/server/tour/prefill.ts`: read-only, no external call, owner only; city = the day's stored stop point, else the trip destination; places = the day's plan refs with coordinates, each with a signed ref; date from the trip dates), `/app/tours/[id]` (owner: form + result; grantee of the linked trip: the stored snapshot, no controls). `/app` lists up to 5 tours below the trips (hidden when there are none); "Neue Stadttour" sits next to "Neue Reise".
- **Saving and computing.** "Tour planen" saves (create, or `updateTour` with the last seen `updatedAt` when the form changed) and then computes; the `updatedAt` of the computation is the next `expectedUpdatedAt`. A new tour moves the address to `/app/tours/<id>` without a reload (proposals and the dropped-overrides notice of that computation stay visible). From a trip day, the user returns to the trip after the first successful computation; a failed computation stays on the tour page with its error. After a save the form continues with the stored points (a Geoapify result may come back with its `osm:` key).
- **Search centre.** The place search needs a centre (`/api/places/search` filters a 20 km circle around it), so a new tour starts with the city; after the first place is added the city may be removed and the first place is the centre (3.1). A search without any centre would be a worldwide query with arbitrary results, so it is not offered.
- **Outdated.** The result is outdated when the server says so (stored hash differs) or when the form's draft differs from the last saved one (stable JSON without refs, `src/lib/tour/ui.ts`). Proposals and the dropped-overrides notice are hidden while outdated. A stored result whose order names a point that is no longer in the input is not shown at all, and a stored outdated result gets no derived times or fit minutes. Edits are locked while a save or computation runs.
- **Map.** MapLibre GL JS 6.16.0 with the OpenFreeMap `positron` style (calm, fits the Atlas palette), loaded with `next/dynamic` only on tour pages. MapLibre 6 starts its worker from a sibling file, which a bundled chunk does not have: `scripts/maplibre/copy-worker.mjs` copies it to `public/vendor/` before `dev` and `build` (gitignored), and the map calls `setWorkerUrl`. `TOUR_MAP_STYLE_URL` overrides the style (https only); `off` disables the map (E2E). On a style or tile error, a missing WebGL or no load within 15 s, the map collapses to "Karte nicht verfügbar" and the SVG route sketch. No CSP exists, so nothing to allow there; OpenFreeMap is listed on the sources page (privacy note).
- **Route sketch.** One component, `src/components/tour/route-sketch.tsx` (props `{ legs, points, width?, height?, label?, className? }`; `label` makes it an accessible image), drawing `sketchGeometry` from `src/lib/tour/sketch.ts` like the PDF. The tour page uses it as the map fallback, the day block as its sketch.
- **Google Maps.** Touch devices (`pointer: coarse`) get links with at most 3 waypoints each (Google's limit in a mobile browser without the app, where extra waypoints are dropped silently); desktop keeps 9. More links for a long tour, but none loses a stop.

### Implementation notes (plan PR, 2026-11-12)

- **Plan input.** `src/lib/plan/tour-blocks.ts` (pure). A tour on a day of the trip with a start time and a stored
  result with a total enters `INPUT.fixed` as `{ day, from, to, cat: "activity", title }`; `to` wraps past midnight
  ("ends the next day", timed-items [D2]). The title is model input, so it follows the plan language like the rest
  of the input: `"Stadttour: <places in visiting order>"` / `"City tour: …"`, start and end left out, cut to 60
  characters with "…". An outdated result (input changed since the computation) is still used: its total is the best
  known duration, and a changed start time alone should not drop the slot. Item slots and tour slots are merged by
  day and start (stable, items first); without tours `fixed` is the same object as before, so the golf, cruise and
  Würzburg inputs are byte-identical (checked against the hashes on main). No prompt change.
- **Duplicate guard.** The OSM stops of every tour on a day (with or without a start time, start and end included)
  are stored beside the input as `PlanInputStored.tourStops` (day → plan keys, not hashed, not sent). In
  `assembleDay`, after the stop-ref guard, a ref that is a tour stop becomes the first alternative that is none (the
  text names the new place, as the open-air guard does); with no alternative left the activity is dropped, because the
  tour block already shows that place on that day. Names of removed alternatives are cut out of the text. Removed keys
  count as `tour_duplicate`. Patches use the current tours (like the current fixed slots). An untimed tour leaves the
  input hash unchanged, so a version reused by the dedupe gets the same guard in code (a restore version that stores
  the current `tourStops`; no AI call). Not covered: unlinking an untimed tour does not bring a dropped activity back
  until the next real generation.
- **Visiting order.** The stored result's order is used only when it covers exactly the current points; otherwise
  the input order (a place added since the last computation is never left out of the block or the slot title).
- **Hint.** The "items changed" note of timed-items [D8] also fires for a tour on a day of the trip with a start time
  whose `updated_at` is later than the version (a computation moves `updated_at` too).
- **Rendering.** `mergeDayRows` takes the tour blocks: timed ones by the [D7] rule (a fixed item before a tour with
  the same start), untimed ones at the top of the day. The block is a `<details>` (no client JS); "Tour öffnen" for
  owner and grantees, the start-time hint for the owner only, nothing of both on the public page. The day action is
  shown to the trip owner on every day card. Tours without a day of the trip are listed on the trip page under
  "Stadttouren ohne Tag".
- **Share and PDF.** The public read (`getSharedPlanDocument`) reads `city_tours` with the secret key filtered by
  `trip_id` and `owner_id` of the link, and drops any row of another trip in code as well. The share box shows
  `share.tourEndpointsVisible` when a tour on a day starts or ends at a `gfy:` Geoapify result. The PDF draws the
  block with a react-pdf `Svg` sketch and a sources line under the days.

### Implementation notes (landmarks, 2026-11-12)

Alex tested Frankfurt: Dom, Alte Oper and Hauptbahnhof were missing from the suggestions, and the search for them
returned street addresses, shops inside the station, a bus stop, a car park and a ticket office. Causes: the
suggestions used the `general` interest (attraction/viewpoint, castle/monument/city gate/fort, `building=cathedral`,
all with wikidata) through the Geoapify fast path, whose categories missed most of it (Frankfurt: 6 places in 15 km,
no church, theatre or station), ranked by distance (Wien: 15 Palais within 300 m); the search was address
autocomplete. Measured live with 21 calls (Overpass 5, one a 502; Wikidata 4; Geoapify 12), plus 6 for the trip extension (Barcelona: Geoapify 3, Overpass 1, Wikidata 2).

**Landmark set** (`src/lib/facts/landmarks.ts`, pure; `src/lib/server/tour/landmarks.ts`, caches and warm-up).
- One Overpass query per city point, 8 km, `out center tags 3000`: places of worship, theatres, arts centres, concert
  halls, town halls, marketplaces; cathedral/church/chapel/basilica/synagogue/mosque/temple/palace/castle/train
  station buildings; museums, galleries, attractions, viewpoints, zoos; historic castles, palaces, monuments,
  memorials, city gates, forts, buildings, churches, towers, ruins, monasteries, city walls, bridges; railway stations
  except subway/light rail/tram; squares; pedestrian streets; towers and bridges; buildings with `landmark=yes`;
  parks, gardens, cemeteries. **Every line needs `wikidata`.** U-Bahn stations are left out (the "Dom/Römer" and
  "Alte Oper" stations shadowed the landmarks); generic buildings only with `landmark=yes` (office towers and
  companies tagged on buildings were most of Frankfurt's noise).
- Code applies the same filter, the exact radius, one element per wikidata id (a castle wins over a gate or park with
  the same id: Hofburg over Schweizertor, Schloss Schönbrunn over the Schlosspark; the other element's names stay
  searchable), one per name within 150 m, at most 2,000 candidates (Frankfurt 448, Wien 1,453, Passau 90; a cap of
  1,000 dropped the Wiener Stadthalle, rank 23 by sitelinks). After ranking, a station that shares a name with a more
  prominent station within 300 m is left out ("Hauptbahnhof (tief)", the S-Bahn level of Frankfurt Hbf).
- **Prominence = Wikidata sitelink count** × kind weight (stations, streets, memorials, markets, plain buildings 0.6;
  parks 0.8; sights 1) / (1 + km from the city point / 5), +1 for a wikipedia tag. Evidence: sitelinks put the
  known sights first in all three cities; the cheap alternative (count of `name:*` tags + wikipedia tag) missed
  Belvedere (62 sitelinks) and Tiergarten Schönbrunn even in its top 300 for Wien, so it is only the fallback
  until Wikidata answered. Sitelinks come from the Action API (`action=query&prop=pageprops&ppprop=wb-sitelinks`,
  50 ids per request, ~250 ms, 3.9 KB for 50; equal to the Query Service values for the 50 checked), serial, with
  `maxlag=5` and the app's User-Agent (`src/lib/integrations/wikidata-sitelinks.ts`). Wikidata data is CC0.
- Caches: `overpass/landmarks` 30 d and `wikidata/sitelinks` 90 d, both keyed by the anchor (3 dp) and radius,
  the sitelinks also by a hash of the set's ids (a refreshed set with new ids fetches its counts again); shared across
  users. A complete set is kept in memory 5 min per instance (Wien's set is ~340 KB; the search reads it per
  keystroke). The warm-up reports done only when the stored set reads back fresh and complete. **Overpass and Wikidata are never called inside a user request**: suggestions, search and
  sights read the cache only. A miss (or an expired entry) schedules the warm-up with Next.js `after()` (budget
  110 s; one per point and instance per 10 min) and queues the place retry job as a fallback. The job reuses kind
  `interest` with the reserved name `landmarks` (no migration of the `kind` check); the worker branches on it.
- While no set is cached, the old `general` places stand in (cache + Geoapify fast path) and the answer is
  `pending`. A Geoapify landmark fast path was measured and rejected: 500 places (25 credits) with landmark
  categories reach only 1.1 km around Frankfurt's centre and miss the Hauptbahnhof, Paulskirche and Städel; Alte Oper
  and Eiserner Steg come back only as stations.
- Suggestions: 40 in total, the landmarks by prominence first, then the linked trip's purpose interests with up to
  20 of the 40 (places that are already landmarks count once). Sights near the route: top 60 landmarks.

**Search** (`src/lib/server/tour/search.ts`, `GET /api/places/search`, new `use=place|endpoint`).
1. Landmarks of the cached set that match: case-, accent- and ß-insensitive on name, `name:de`/`name:en`,
   `alt_name`, `short_name`, `official_name`, `loc_name`, `old_name`; an equal name first ("Dom" = loc_name of the
   Kaiserdom), then a word start ("Hauptbahnhof" in "Frankfurt (Main) Hauptbahnhof"), then inside a word ("dom" in
   "Stephansdom"); within a tier by prominence. They are OSM points with `osm:` keys and refs signed like the
   suggestions (nothing to resolve on save).
2. Geoapify Autocomplete for the rest, skipped when 8 landmarks matched. Places: `type=amenity` (no streets,
   buildings or postcodes) and a category allow-list (sights, attractions, entertainment, religion, heritage,
   historic buildings, parks, natural, man-made, train; no food, shops, health, car parks, hotels, offices,
   tickets, bus or tram stops); new cache key v2. Results without a category stay only while no landmark matched
   (the Kaiserdom has none in Geoapify; the "Holiday Inn Frankfurt - Alte Oper" and "Tourist Information Römer" have
   none either). Start and end (`use=endpoint`): the old address autocomplete (v1 key), addresses and hotels allowed.
3. A Geoapify result that is a matched landmark is dropped: the same name within 300 m, or for an uncategorized or
   transport result one name inside the other (the station's "Hauptbahnhof" B level, the "Dom/Römer" U-Bahn).

**Before / after: top 15 suggestions** (before: the live `general` Geoapify fast path for Frankfurt and Wien, the
recorded `general` Overpass fixture for Passau; after: the recorded landmark sets and sitelinks).

| # | Frankfurt before | Frankfurt after | Wien before | Wien after | Passau before | Passau after |
|---|---|---|---|---|---|---|
| 1 | Kaiserpfalz franconofurd | Frankfurter Wertpapierbörse | Stock im Eisen | Stephansdom | Glasscherbenvilla | Dom St. Stephan |
| 2 | Saalhof | Paulskirche | Palais Bartolotti-Partenfeld | Hofburg | Schloss Freudenhain | Passau Hbf |
| 3 | Affentorhäuser | Kaiserdom St. Bartholomäus | Palais Equitable | Wiener Staatsoper | Severinstor | Veste Oberhaus |
| 4 | Bieberer Aussichtsturm | Städel Museum | Stephansdom | Belvedere | Alte Residenz | St. Michael |
| 5 | Ellerhöhturm | Römer | Erzbischöfliches Palais | Kunsthistorisches Museum | Dom St. Stephan | Pfarrkirche Sankt Paul |
| 6 | Wasserturm | Messeturm | Palais Eskeles | Albertina | Neue Residenz | Stadttheater Passau |
| 7 | – | Alte Oper | Palais Gatterburg | Prunksaal der ÖNB | Veste Oberhaus | Museum Moderner Kunst |
| 8 | – | Römerberg | Palais Neupauer-Breuner | Burgtheater | Veste Niederhaus | Fernmeldeturm Passau |
| 9 | – | Goethe-Haus | Palais Starhemberg | Naturhistorisches Museum | Burgruine Hals | Domplatz |
| 10 | – | Senckenberg Naturmuseum | Kohlmarkt | Karlskirche | Burg Reschenstein | Neue Residenz |
| 11 | – | Frankfurt (Main) Hauptbahnhof | Palais Corbelli-Schöller | Schloss Schönbrunn | Schloss Neuburg | Sankt Peter |
| 12 | – | Katharinenkirche | Palais Erdödy-Fürstenberg | Kaisergruft | Burg Wernstein | Mariahilf |
| 13 | – | Main Tower | Palais Fürstenberg | Rathaus | Ruine Wimberg | Sankt Anton |
| 14 | – | Oper Frankfurt | Palais Kaiserstein | Musikverein | Kubin Haus | Passauer Glasmuseum |
| 15 | – | Museum MMK | Palais Rottal | Spanische Hofreitschule | Ruine Königstein | St. Josef |

Eiserner Steg is in the Frankfurt set (rank 53, so among the sight candidates, not the 40 suggestions) and found by the search. Passau's GeoNames point lies 2.7 km from
the Dom, so the distance term favours the Fernmeldeturm next to it; the sitelink counts there are small (Dom 22,
Hbf 9, Veste Oberhaus 6). The Wertpapierbörse leads Frankfurt because OSM tags the exchange building with the
institution's item (54 sitelinks) and `amenity=marketplace` (weight 0.6).

**Before / after: first 3 search results around Frankfurt** (before: Alex's live test without `type`; after: the
recorded `type=amenity` answers merged with the landmark set, `src/lib/server/tour/search.test.ts`).

| Query | Before | After |
|---|---|---|
| Dom | street addresses only (Domstraße …) | Kaiserdom St. Bartholomäus · Dominikanerkloster · Dommuseum |
| Kaiserdom | not measured | Kaiserdom St. Bartholomäus |
| Alte Oper | Alte Oper (theatre) · bus stop · car park (plus an office, a ticket office) | Alte Oper |
| Hauptbahnhof | Deutsche Post · Burgertime · … (businesses inside the station) | Frankfurt (Main) Hauptbahnhof · Offenbach (Main) Hauptbahnhof (nothing else: the S-Bahn level and the uncategorized exits and stops are the station) |
| Römer | not measured | Römer · Römerberg · Haus zum Römer |

**Trips: the same prominence for interest places** (scope extension by Alex, 2026-11-12). "Orte zum Vormerken"
said "sortiert nach Bekanntheit und Entfernung", but `rankCandidates` only scored has-wikidata/has-wikipedia and the
city filters require wikidata, so the 25 kept were the 25 nearest: in Barcelona the Sagrada Família (2.1 km) was cut
by 44 items within 1.5 km.
- `rankCandidates(…, { sitelinks })` (`src/lib/facts/places.ts`): prominence bucket floor(log2(sitelinks + 1)) first,
  then the old wikidata/wikipedia flags, then the distance (distance stays the key within a bucket: 64-127 sitelinks
  is one bucket, 32-63 the next, …); with sitelinks, one place per Wikidata item (La Rambla is several tagged
  segments). Without `sitelinks` the order is byte-identical to before.
- Applied to the interests whose places usually have a Wikidata item (`prominence` in `interest-sources.ts`):
  city_sightseeing/general, architecture, history, museums, nature_wildlife, family_activities, hiking. Golf, beach,
  wellness, food and the rest are unchanged (same keys, same order). The counts come in the Overpass and Geoapify
  fetchers (cache miss only): the Wikidata items within the radius, at most 500 (10 requests), cached 90 days as
  `sitelinks:v1:ids=<hash>;n=<count>`, at most 15 s; when Wikidata does not answer, the list is ranked as before and
  cached for one day instead of 30. Their Overpass queries return up to 1,000 elements (the default 150 would be an
  arbitrary subset to rank). The
  Wikidata client sends one request at a time per instance. The discover variant (find destinations) is not ranked.
- Flagged interests use cache key v3 (`interpreter:v3`, `places:v3`), so every trip fetches its list once more
  (Geoapify credits; Overpass via the retry job).
- **Overpass first for `general`** (`overpassFirst`): Geoapify's 100 nearest per category group do not contain the
  Sagrada Família, Park Güell, Casa Batlló or La Pedrera (Barcelona, 298 elements, 72 matching, measured) and gave
  Frankfurt 6 places, so a Geoapify answer only stands in and the Overpass lookup is queued for the place retry job
  (`interest` job with `overpass: true`, key suffix `:overpass`, never inline). Once Overpass is cached the fast path
  prefers it.
- Evals: `evals/build-input.ts` and `evals/port-places.ts` rank recorded Overpass fixtures without sitelinks, so the
  recorded inputs and the golf / cruise / Würzburg hashes are unchanged; no eval needs re-recording. The evals do
  therefore not exercise the prominence order.
- UI text (`places.intro`, de + en) now says what the code does: the best known first (sitelinks for sights, museums
  and the like, otherwise whether there is a Wikipedia article), the nearer first among equally known.

Barcelona, `general`, 15 km (Overpass, recorded; Casa Batlló and La Pedrera have no element with a Wikidata id in the
matching categories, so they cannot appear):

| # | Before (distance order) | After (prominence) |
|---|---|---|
| 1 | Carrer del Consell de Cent | Spotify Camp Nou |
| 2 | Carrer del Consell de Cent | Basílica de la Sagrada Família |
| 3 | Mercat del Ninot | Plaça de Catalunya |
| 4 | Museu del Modernisme Català | La Rambla |
| 5 | Rambla de Catalunya | Palau de la Música Catalana |
| 6 | Carrer del Consell de Cent | Catedral de la Santa Creu i Santa Eulàlia |
| 7 | Editorial Montaner i Simón | Palau Güell |
| 8 | La Villarroel | Casa Vicens |
| 9 | Museu Tàpies | Parc Güell |
| 10 | Rambla de Catalunya | Sant Pau Recinte Modernista |
| 11 | Rambla de Catalunya | Carrer de la Selva de Mar |
| 12 | Casa Lleó Morera | Ajuntament de Santa Coloma de Cervelló |
| 13 | Casa Mulleras | Museu Nacional d'Art de Catalunya |
| 14 | Casa Pia Batlló | Severo Ochoa |
| 15 | Museu del Perfum | Casa Lleó Morera |

Known noise: OSM elements whose `wikidata` names their subject, not themselves (a town hall 12 km out tagged with its
municipality, 46 sitelinks; a monument tagged with the person, 61; a street with a district item). Distance only
orders within a bucket, so such items can rank high anywhere in the radius. Frankfurt with the `general` filters
(12 km recording): Wertpapierbörse, Paulskirche, Commerzbank Tower, Städel, Hauptbahnhof, Messeturm, Zeil,
Katharinenkirche, Kaiserdom, Römer, Goethe-Haus, Römerberg, Alte Oper, Main Tower in the top 15 (before: Frankfurter
Engel, Klaus-Mann-Platz, Kochkunst-Museum, MyZeil, … by distance).

**Quotas.** Overpass: one query per city per 30 days, in the warm-up or the retry job only (40-55 s on
overpass-api.de, 278 s for Wien on the private.coffee mirror; the job's 120 s cap can cut a slow mirror, the next run
retries). Wikidata: per city per 90 days (and after a refreshed set with new ids) 2 (Passau) to 30 (Wien) light requests. Geoapify: no new Places credits
(suggestions no longer need the `general` Geoapify lookup once the landmarks are cached: 11-15 credits less per new
city); place searches use a new cache key, so queries cached before are fetched once more, and a query that 8
landmarks answer costs nothing.

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
- **[T18] Caps: 10 places + start + end (25 since phase 2, 17.1 [P1]), 50 tours per user; standalone tours purged 18 months after the later of
  date and last change.** *Recommended.* Alternatives: 8 places (shorter lists on phones), no retention.
- **[T19] Spike first, then MVP as section 14, phase 2 after use.** *Recommended.*

## 16. Risks and unknowns

- ORS green and noise data do not cover Wien (spike 2026-11-12): there `green` and `quiet` are accepted but give the
  fastest route. They stay offered (T5); the help text says so.
- The Directions quota (2000/24 h, spike 2026-11-12) is shared with drive searches; a busy day can block tours
  until the endpoint split lands.
- OpenFreeMap is a donation-run service without an SLA; the list and the SVG sketch must stay fully usable without
  it.
- ORS walking times assume a constant speed and ignore crowds, crossings and lifts; the footer says so.
- A Geoapify autocomplete result without OSM identity cannot be matched to plan places for the duplicate guard.

## 17. Phase 2 (issue #205, decided by Alex 2026-11-13)

Phase 2 = the section 14 list plus three requests from the issue: 25 stops, directions that follow the app's route,
public transport. No item adds an LLM call (rule 2): the pasted list is a code split plus the place search.

### 17.1 Decisions

- **[P1] 25 stops: exact order up to 16 points, a deterministic heuristic above.** `MAX_TOUR_PLACES = 25` (+ start
  + end = 27 points). Held–Karp needs 2^n·n states (27 points ≈ 3.6·10^9: impossible); up to 16 points it stays
  < 100 ms. Above 16: nearest-neighbour from every allowed start, then 2-opt and Or-opt until no gain; ties by input
  order, so the same input gives the same order. The result says "sehr gute Reihenfolge, nicht garantiert die beste"
  when the heuristic ran. ORS `/optimization` (VROOM) is rejected again: also heuristic, plus an endpoint and quota.
- **[P2] Directions only on request.** Nothing directions-related is computed with the tour. A "Wegbeschreibung"
  button on a computed tour calls ORS Directions per run again **with steps kept** and shows turn-by-turn steps per
  leg; the same view offers a GPX download.
  - **One route source for the view.** Steps and GPX both come from that on-request response (its geometry and
    steps), so they always describe the same path. The stored `result` stays the source for times, checks, map and
    PDF. If any leg of the response differs from the stored leg by more than 5 % or 50 m in distance, the view shows
    "Die Route hat sich seit der Berechnung geändert" with "Tour neu berechnen"; steps and GPX are still the
    response's.
  - Steps are stored compactly (`[type, name, metres, wayPointIndex, exit?]`, `exit` = ORS `exit_number`, only on
    type 7 "enter roundabout"; about 10 kB for 26 legs, spike 17.2) under
    their own cache key `cacheKey("tour-steps", 1, { profile, route, h })` (90 d), never in `city_tours.result`.
  - Sentences are built by code from the ORS step `type` (0–13) and street `name` with `tours.steps.*` messages
    (de + en), so one request serves both locales and ORS's English `instruction` text is not shown. `name` "-" =
    unnamed way.
  - Roundabout: type 7 with `exit` uses `tours.steps.roundabout` ("Im Kreisverkehr die {exit, selectordinal, …}
    Ausfahrt nehmen{name}"); without `exit`, `tours.steps.roundaboutNoExit`. Type 8 (exit roundabout) is merged
    into the type 7 sentence.
  - Same ORS gate as a computation (Directions bucket `>= runs`); rate limit shared with computations.
  - Google Maps links stay as they are (label: Google may route differently).
- **[P3] Public transport only per leg, from timetable data, if the spike passes.** Candidate: Transitous (MOTIS,
  open GTFS data). Never used for the order (a transit matrix would cost n² requests): a leg can be set to
  "ÖPNV" as a leg override, or the whole tour with "Meine Reihenfolge". Needs date and start time; legs are timed in
  sequence (departure = previous arrival + dwell), one request per transit leg. The leg shows line, departure,
  arrival and walking parts, "Fahrplan, keine Echtzeit", source and check date; no connection = failed leg. Short
  cache (7 d). **Spike passed technically (17.2, 2026-11-13); the terms set conditions** that must hold before the
  build (transitous.org/api, read 2026-11-13):
  - only for **open-source, non-commercial** projects that are "light on resources". The repo is public and
    MIT-licensed since #219 (Alex's choice, 2026-11-13), so this condition holds; non-commercial use stays a
    condition for as long as Transitous is used.
  - every request sends a `User-Agent` with app name, version and a contact (the repo URL).
  - attribution: a visible link to `https://transitous.org/sources/` (source line of a transit leg) plus the OSM
    attribution the app already shows.
  - more than 720 `/plan` requests per 24 h need coordination with Transitous: a guard `TRANSITOUS_DAILY` (default
    500) counted over `api_calls`, as for ORS.
  - best effort, no SLA, can be withdrawn: a transit leg that fails shows why and offers walking; never a guess.
  - Request: `GET /api/v6/plan?fromPlace=lat,lon&toPlace=lat,lon&time=<ISO with offset>` (MOTIS 2). Times come back
    in UTC (`Z`) and are shown in the tour's local time. A leg carries `mode`, `displayName`/`routeShortName`,
    `headsign`, `agencyName`, `startTime`/`endTime`, `scheduledStartTime`, `realTime`, `scheduled`, `from.name`.
  - Store compactly: responses are 25–380 kB (geometry, intermediate stops); keep the first itinerary that departs
    at or after the leg's departure: per part mode, line, headsign, from/to stop names, times, polyline.
  - The response's `direct` walk is compared: when walking is not slower than the best connection, the leg says so
    and stays walking (Passau and Frankfurt cases).
- **[P4] Tour sharing exactly like trip sharing.** `tour_shares` (`share_resource` gains `'tour'`,
  `private.shared_tour_ids()`, `writable_tour_ids()`), public link via `share_links.tour_id` (exactly one of
  `trip_id`/`tour_id`). Needs the CLAUDE.md rule 6 table list extended first (own PR).
- **[P5] "Use my location" as start: dropped** (not a use case worth the exception to "the browser never supplies
  coordinates").
- **[P6] Per-stop time windows + parsed opening hours, one feature.** User windows `TourPoint.window?: { after?:
  HhMm; before?: HhMm }` constrain the order (DP with earliest finish time up to 16 points, heuristic with a
  feasibility check above). OSM `opening_hours` is parsed on the server only (`opening_hours.js`, LGPL-3.0, kept out
  of the browser bundle) and used for checks only ("laut OpenStreetMap um 10:20 geschlossen, geprüft am …"), never
  as a window by itself.
- **[P7] Waterfront option: dropped.** Up to one Directions request per leg (26 with 25 stops) plus Overpass, for an
  effect that cannot be checked well.
- **[P8] Weather: daily forecast only.** Open-Meteo `/v1/forecast` daily values for the tour date at the tour centre,
  with `timezone=auto` (day boundaries in the tour centre's local time zone; the default would be GMT),
  only when the date is within 16 days: weather code, max/min temperature, precipitation sum and probability. Cache
  key `forecast:v1:{lat2,lon2,date}`, TTL 3 h. Shown with source and check date; outside the 16 days nothing is
  shown.
- **Small items:** e-bike mode (`cycling-electric`, spike 17.2), paste a list of places (split by line, comma or
  semicolon; each name through the place search, at most 25; the user confirms each match), standalone tour PDF
  (trip PDF tour block + SVG sketch, route `/api/tours/[id]/pdf`).

### 17.2 Spike results (2026-11-13)

7 ORS calls (heigit), 27 points on a 3 km grid around Wien Stephansplatz, one Open-Meteo call and 4 Transitous calls (User-Agent with the repo URL as contact).

| # | Call | Result |
|---|---|---|
| 1 | matrix `foot-walking`, 27 × 27 | 200, 2.4 s, no nulls. Fits `ORS_TIMEOUT_MS` (10 s). |
| 2 | Directions `foot-walking`, 27 waypoints, `instructions: true` | 200, 0.33 s. 26 segments, 535 steps, polyline 4.6 kB, response 68 kB. Step keys `distance, duration, instruction, name, type, way_points`; types seen 0–6, 10–13; unnamed ways have `name: "-"`. Compact steps ≈ 9.7 kB. |
| 3 | Directions `cycling-electric`, fastest, 3 points | 200, 1.7 km in 6.1 min (regular: 7.6 min). Warning code 4 as for foot. |
| 4 | Directions `cycling-regular`, fastest | 200, 1.68 km, 7.6 min. |
| 5 | Directions `cycling-regular`, shortest | 200, 1.66 km, 12.8 min (pushing through a pedestrian area). |
| 6 | Directions `driving-car`, fastest | 200, 2.19 km, 7.4 min, no warnings. |
| 7 | Directions `driving-car`, shortest | 200, 2.19 km, 7.5 min. |
| 8 | Open-Meteo forecast, daily, 16 days, Wien | 200, 0.06 s. Fields as P8; the 16th day had `precipitation_probability_max: null`, so every daily value is nullable. |
| 9 | Transitous `/api/v6/plan`, Wien Stephansdom → Schönbrunn, weekday 10:00 | 200, 0.21 s, 267 kB. Several itineraries (U1+U4 32 min, U4 36 min, U3+tram 60 33 min); `numItineraries: 2` was not honoured (window-based). Wiener Linien, `scheduled: true`, `realTime: false` for a future day. |
| 10 | Transitous, Passau Dom → Veste Oberhaus | 200, 0.06 s. Bus K2 (Stadtwerke Passau) 14 min; `direct` walk 16 min. |
| 11 | Transitous, Barcelona Sagrada Família → Park Güell | 200, 0.12 s, 376 kB. L5 + bus H6 (TMB) 26 min, several alternatives. |
| 12 | Transitous, Frankfurt Römer → Städel | 200, 0.08 s. Tram 11/12/14 (VGF) 18 min; `direct` walk 18 min, so walking is as fast. |

Each ORS call decremented its own endpoint counter by 1 (matrix 500, Directions 2000), as in the 2026-11-12 spike.

### 17.3 PRs (each with CodeRabbit review)

1. Migration (only if the worst-case test of 1b needs it): `city_tours` size checks (input 16 kB, result 256 kB).
2. 25 stops: heuristic order, cap, label, long list at 360 px.
3. Directions on request: steps client + cache, step sentences, GPX, "Wegbeschreibung" view.
4. E-bike mode. 5. Paste a list. 6. Daily forecast. 7. Standalone PDF.
8. CLAUDE.md rule 6 → migration `tour_shares` + `share_links.tour_id` → server → UI.
9. Public transport (licence condition met by #219, see [P3]). 10. Time windows + opening hours.

### 17.4 Clarifications (review of this section, 2026-11-13)

Each point below is binding for the implementation and wins over a shorter sentence above.

- **Computation vs. directions [P2].** The computation still requests ORS Directions per run and stores each leg's
  minutes, km and polyline in `result` (map, PDF, times, checks). Only turn-by-turn steps and the GPX are on request.
- **One cache entry for the view [P2].** The `tour-steps` entry stores, per leg, the steps **and** the polyline of
  that answer, so a later cache hit still yields a GPX that matches its steps.
- **"Changed" means distance or geometry [P2].** A leg is `changed` when its distance differs by more than 5 % or
  50 m, **or** when any point of either polyline lies more than 50 m from the other one (both directions, point to
  segment, the sights corridor helper), so an added or a removed detour both count. The notice shows for any
  changed leg.
- **"Tour neu berechnen" from that notice [P2]** forces a recomputation: it skips the unchanged-input shortcut and
  refreshes the `tour-route` entries of its runs (`cached({ refresh: true })`, a fetch that replaces the row), then
  stores the new result. It counts against the computation limits like any computation. The directions request
  refreshes a `tour-steps` row whose `fetchedAt` is older than the tour's `computed_at`, so steps and GPX follow the
  recomputed route.
- **Large results [P1].** All stored geometry of one result (ORS leg polylines and transit `legGeometry`) shares a
  200 kB budget (at most 20 kB per leg); a leg over its share keeps minutes and km without the line. The same cap is
  applied before a route is cached. The result stays under the 256 kB check, so no migration.
- **Transitous quota [P3].** A new table `provider_slots` (provider, cache key, `reserved_at`, `expires_at` = +2 min,
  `done`), not `api_calls` (its `status` is the HTTP code). A security-definer function reserves a slot under a
  transaction-level advisory lock per provider: it counts the last 24 h of `api_calls` rows plus unexpired, not yet
  done slots, refuses at `TRANSITOUS_DAILY`, and refuses a second live slot for the same cache key (that caller
  waits for the cache instead: in-flight dedupe). The caller marks the slot done after logging the call. An expired
  slot (process died) stops counting by itself. No slot, no request (fail closed). Migration with the transit PR.
- **Transit time zone [P3].** Transit needs a tour city with a known IANA time zone (GeoNames via Open-Meteo, as the
  city point carries). Requests send the departure as local time with that zone's offset on the tour date; UTC
  answers are shown in that zone. Without a city time zone the ÖPNV option is not offered.
- **Transit legs in the tour [P3].** A transit leg is computed during the computation, after the ORS runs, in
  sequence (departure = previous arrival + dwell). The chosen itinerary is the first that departs at or after that
  time; the leg's minutes are its **arrival minus the requested departure**, so the wait at the stop counts. They
  replace the leg's minutes everywhere: totals, stop times, fit check, proposals ("ca." as now). Its km and line come
  from the itinerary's `legGeometry` (walking parts included). It is stored in `result` like any leg: `TourLeg.mode`
  gains `"transit"` (an override only, never a tour mode) and an optional `transit` part list, both in the Zod
  schema. The result stores the oldest transit `fetchedAt`; when it is older than 7 days, the unchanged-input
  shortcut recomputes instead of returning the stored result.
- **Transit legs in the directions view and GPX [P3].** No ORS call for them: the view lists the stored parts
  (walk to stop, line and headsign, departure/arrival, stops count, walk to the place) with "Fahrplan, keine
  Echtzeit" and its source; the GPX uses the stored line.
- **Time windows [P6].** Type `TourPoint.window?: { after?: HHMM; before?: HHMM }` with the existing `HHMM`
  validator from `domain/common.ts`, added to `TourPoint`, `TourPointDraft` and `resolveDraft`, and to
  `tourInputHash` (hash version bump, so stored results recompute). `after` must be before `before` (field error). Windows are wall-clock times of the tour day, like `startTime`, so arrivals
  (`startTime` + minutes) and windows compare without a time zone. A window needs `startTime` (schema refine with a
  form message); without it the window fields are disabled. Opening hours are checked only with a date and a city
  time zone (holidays and DST); otherwise the raw tag is shown as today.
- **Standalone tour share links [P4].** `share_links.trip_id` becomes nullable in the sharing migration, with a check
  that exactly one of `trip_id` and `tour_id` is set.
