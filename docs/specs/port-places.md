# Places per stop and plan-8 (multi-anchor trips)

Status: decided (2026-11-11). Alex accepted [P1]–[P10] as recommended, with [P5] = drive times for every stop and [P6] = 10 stops. Supersedes `concrete-places.md` [D8] and the
"per-day query is out of scope" note in `activities-and-restaurants.md` §3 once accepted.

**Split with `docs/specs/itinerary-upload.md`** (both specs describe one stop model):
- itinerary-upload owns the stop data: the `TripStop` schema and `trips.stops` (its [D4]), the stop sources and
  their resolution order (its [D10]), and the one Haiku task that reads stops from documents and from the trip notes
  (its [D2]).
- This spec owns everything the plan does with stops: the one plan-input change and prompt bump `plan-8` (§3,
  [P2]), the code guards (§3, [P3]), places per stop (§1–§2), patches (§4) and feedback (§5).

## Problem

User feedback from the live site (2026-11-11): a multi-port cruise. The user typed the itinerary (ports and times)
into the trip notes, and the plan picked up every stop and time correctly. Only the start port, which is the trip's
destination, got concrete linked places (activities, restaurants with "oder:" alternatives, drive times). Port days
far from it only had generic text ("Bummel durch Hafen und Altstadt", "Mittagessen in Hafennähe"). The user then
asked "Plan anpassen" to "add concrete restaurant suggestions for the days we're on land in other cities". The
answer was "Es hat sich nichts geändert." with no reason.

## Root cause

1. **Places are fetched around one point.** Interests, activity groups, restaurants and cafés use the destination
   anchor only (`getInterestGroups`, `loadActivityLookups`, `src/lib/server/facts/`). This was accepted on purpose
   (`concrete-places.md` [D8]); "one place query per port" was named as the next step.
2. **Stops exist only as free text and as model output.** `trip.notes` holds the schedule. The model turns it into
   `PlanStop.place` strings. Code only checks times (`noteTimes`, `guardScheduleTimes`). No code knows which day is
   at which port before generation. itinerary-upload adds structured stops.
3. **The patch cannot reach a port.** `needPlaces.restaurants.near` must be an input place id. Ports have none, and
   an unknown id silently falls back to the destination (`resolveNeedPlaces`, `src/lib/plan/need-places.ts`). In
   this case a second call would load the start port's restaurants again.
4. **The reason is dropped.** Prompt rule 15 asks for a "nicht in den geprüften Quellen enthalten" note, but the
   model returned no changed day. The pipeline then sends `unchanged` + `reply`. The client ignores `reply` when
   `unchanged` is set (`plan-iterate.tsx`: `json.unchanged ? unchangedText : json.reply`). The user sees the bare
   `noChange` text even when the model explained why.

## Design

### 1. From stops to stop places

**Input.** `tripStops(trip): TripStop[]` from itinerary-upload §2 / [D10]: confirmed `trips.stops`, else stops
derived from `trip.notes`, else none. Fields used here: `day`, `place`, `cc?`, `sea?`. `arr`/`dep`/`note` matter only
for the port-window guard (§3). Where a stop came from does not matter.

**Geocoding [P1].** Each distinct place name is geocoded by code (`src/lib/server/facts/stops.ts`, new):
- Reuse `resolveAnchor`'s logic (`src/lib/server/discover/verify.ts`). Move it to a shared helper
  `resolvePlaceName(name, cc, lang, deps)`. It runs Open-Meteo search in en, then de, then the country language, and
  keeps populated places (`PPL*`) via `pickAnchorPlace`.
- Country: the stop's `cc` (set by the AI extraction), else the destination's country code. If neither finds a
  place, try once more with an exact-name match in any country and take the largest population. Typed stops have
  no `cc`, and a cruise from a German port visits other countries.
- Everything goes through `cached()` (30 d search, 365 d by id) and so is logged in `api_calls`.
- Each name gets a role:
  - **destination**: within 5 km of the trip anchor (the trip destination, "Passau" in the fixture; it is often the start, but need not be). No own lookups, the
    destination's places apply.
  - **stop**: own lookups (§2), id `s1..` in day order.
  - **not_found**: no matching populated place. No lookups; the model and the notices (§5) say so.
  - **error**: geocoding failed. Same handling as a failed lookup.
  - Sea entries (`sea: true`) are never geocoded.
- A stop is keyed by `geoId`. The same port on two days is one stop with `days: [n, m]`. Dürnstein and Melk on one
  day are two stops.

```ts
type ResolvedStop = {
  id: string;             // "s1"
  name: string;           // GeoNames name in the plan language
  days: number[];
  role: "stop" | "destination";
  point?: { lat: number; lon: number; geoId: number };
  status: "ok" | "not_found" | "error" | "cap";
};
```

Example (cruise fixture): Passau on days 1 and 5 = destination. Wien day 2 (`s1`), Dürnstein day 3 (`s2`), Melk
day 3 (`s3`), Linz day 4 (`s4`).

### 2. Lookups per stop [P4]

Each stop with `status: "ok"` becomes a `GeoDestination` of kind `city` at its point, with the default city radius
of 15 km. The existing functions are called unchanged, so cache keys are shared with any city trip to that town:

| Lookup | Function | Radius | Kept per stop |
|---|---|---|---|
| Restaurants (always) | `getRestaurantFacts` | 2.5 km (`RESTAURANT_RADIUS_KM.city`) | 6, same cuisine filter as the destination (`selectRestaurants`) |
| Interest places | `getInterestGroups` | `radiusForInterest(k, 15)` | first 2 purpose interests with an OSM source (`interestsForTrip` order, `general` when none), 4 places each |
| Cafés (only if the purpose or request asks) | `getCafeFacts` | 2.5 km | 3 |
| Activity groups | not per stop | | wishes stay on the destination; at a stop they count as not checked (rule 17) |

- For the cruise the 2 interests are `family_activities` and `general` (Christmas markets have no source).
- Inline runs (Generate, patch) use the fast path only: cache, then Geoapify. Overpass network queries for stops run
  only in the warm-up and the retry worker [P7]. `getInterestGroups` and the restaurant/café `lookup` need a small
  option `overpass: "cache_only"`.
- Stops run one at a time (`STOP_CONCURRENCY = 1`), in parallel with the destination lookups.
- Drive times for stop places [P5]: one ORS matrix per looked-up stop, from the stop point to that stop's places
  (`getDriveTimes` in `src/lib/server/facts/drive-times.ts`, unchanged; same cache key rule, so a stop shared with
  another trip is a hit). `km` stays the straight line from the stop point, `PlanPlace.drive` is set as for the
  destination. The matrices run in parallel inside the existing 10 s ORS budget; a stop without a result simply
  has no drive times. This serves round trips by car; on cruises the times are hidden by default anyway.
- `TripFacts` gets `stops?: StopFacts[]` (`{ stop: ResolvedStop; places: PlaceGroup[]; restaurants?: RestaurantLookup; cafes?: CafeLookup }`).
  It is not persisted.

### 3. The plan-8 change: input, prompt, guards [P2] [P3]

This is the only plan-input change and the only prompt bump for stops; itinerary-upload §5 refers here.

**Input** (`buildPlanInput`; `src/lib/plan/stops-input.ts` new):

```ts
// PlanInput additions, absent when tripStops(trip) is empty
trip.stops?: {               // the schedule, one row per TripStop, sorted by day then arr ?? dep
  day: number; place?: string; arr?: string; dep?: string; sea?: true; note?: string;
  at?: string;               // set by code: "dest" or the stop id ("s1"); absent on sea days
}[];
stopPlaces?: {               // one entry per geocoded stop (role "stop"), and per not_found / capped name
  id: string;                // "s1"
  name: string;              // "Wien"
  s?: "not_found" | "error" | "skipped" | "cap";   // set when nothing could be looked up
  places?: { id: string; name: string; cat: string; km: number; i: string | string[] }[];  // p.. ids, km from the stop
  restaurants?: { s: LookupStatus; tooFew?: true; list: { id: string; name: string; c?: string; km: number; k?: true }[] };
  cafes?: { s: LookupStatus; list: { id: string; name: string; c?: string; km: number; k?: true }[] };
}[];
```

- `trip.notes` stays as it is. Trips without stops keep exactly the same input, so their hash is unchanged (only
  the prompt version moves).
- Destination days = days with a row `at: "dest"`, plus days with no row at all. Code derives them; nothing extra
  is sent.
- Ids continue the global ranges (`p`, `r`, `c`), so `indexHit`, `resolveAlts`, `referencedPlaces`, share view and
  PDF work unchanged. Stop rows have no `min` and no `ap`. Stop restaurant blocks have no `ask`: the filter is the
  destination's (`INPUT.restaurants.ask`).
- `PlanIndexEntry` gets `stop?: string` (the stop id). It is not sent to the model. `StoredInput` validation stays
  loose, and older rows parse.

**Prompt `plan-8`.**
- INPUT legend: add `trip.stops` and `stopPlaces`.
- Rule 5 (itinerary-upload [D6]): "Copy every fixed time from trip.stops (arr → from, dep → to), else from
  trip.notes. trip.stops win when both give a time for the same place and day. A note such as 'Ankunft morgens' is
  not a time."
- Rule 3: replace "stops far from the destination" by "stops without their own lists in stopPlaces".
- New rule 17: "A trip.stops row with at = a stopPlaces id: activities and meals at that stop use only that
  entry's ids (rules 3 and 16 apply as for the destination). Never use a stop's ids on other days. Use destination
  ids (places, activities, restaurants, cafes) only on days with a row at dest or with no row. On rows with sea set
  no ref. s not_found = the place was not found; s error, skipped or cap = its places could not be checked. Then
  meals and sights there stay generic, and the day's note says so once (de: 'Orte in X konnten nicht geprüft
  werden'). Restaurants s empty = none found nearby in OpenStreetMap. Activity wishes were only looked up at the
  destination: at a stop they were not checked, never 'not found'."
- Patch addendum: "`restaurants.near` and `cafes.near` may be a stopPlaces id (s1..) to load more around that
  stop."

**Code guards** (both run in `assembleDay`, so they cover generate and patch; issues are logged with
`plan.generated` / `plan.patched`):
1. **Port windows** (from itinerary-upload §5). For each `trip.stops` row with `arr` or `dep`, the plan stop of that
   day whose place matches (`placeMatches`, moved from `evals/checks.ts` to `src/lib/plan/`) gets `fixed: true` and
   those times as `from`/`to`. No match counts as `port_window_missing`.
   - The times "from your input" are now `noteTimes(notes) ∪ trip.stops times`, so `fixed` and
     `guardScheduleTimes` also accept confirmed stop times.
   - The badge `plan.fromNotes` ("aus deinen Notizen") is reworded to "aus deinen Reiseangaben" (de + en).
2. **Stop refs** (`src/lib/plan/stop-refs.ts`, after the open-air guard):
   - A ref or alt whose index entry has `stop` must sit on a day that has a row with that `at`.
   - A destination ref on a non-destination day is allowed only within 10 km straight line of one of that day's
     stop points. This covers region trips whose destination places reach a nearby stop.
   - On a day whose only rows are sea rows, every ref is dropped.
   - A dropped ref is replaced by the first valid alt (the same as `guardOpenAir`). Without one, the activity keeps
     its text without a ref.
   - Counted as `stop_mismatch`.
   - `DayCtx` gets `stops?: { byDay: Map<number, Point[]>; days: Record<string, number[]>; destDays: Set<number>; seaOnly: Set<number> }`,
     built once in `guardCtx`.

### 4. Patches ("Plan anpassen") [P8]

In `iteratePlan`, before the first patch call:
1. **Upgrade an old input.** The base input has no `trip.stops` (made before plan-8), but `tripStops(trip)` is not
   empty. Resolve the stops, run the stop lookups and add `trip.stops`/`stopPlaces` + index entries
   (`extendInputWithStops`, pure).
2. **Retry failed stops in scope.** Scope = `FEEDBACK.days`, or every day when none are selected. Stops with
   `s: error | skipped` are looked up again; they may be cached by now (warm-up, retry worker).
- Both steps share one budget: `min(30 s, left − 240 s)`, cache + Geoapify only. That leaves the existing
  needPlaces deadline (`ITERATE_DEADLINE_MS` 270 s, `NEED_PLACES_MAX_MS` 60 s, second call ≥ 120 s) intact.
- Failures enqueue retry jobs (`place_retries`, R2: the stop point is the job's point; no new job kind).
- The new version stores the extended input, so the next patch reuses it. A patch that changes nothing writes no
  version, as today; the lookups are then cache hits next time.
- Known limit: if the user confirmed `trips.stops` after the base version, the upgrade uses the current stops while
  the base plan's windows came from the notes. The trip edit already marks the plan outdated. The port-window
  guard applies the current times to the days the patch returns.

needPlaces:
- `resolveNeedPlaces`: `near` = a stop id resolves to the stop point. Restaurants or cafés there use the stop radius
  (2.5 km, same cache key as the stop lookup, so a new cuisine is a re-filter) and replace that stop's list in
  `stopPlaces`.
- An unknown `near` id no longer falls back to the destination. It makes the request `needPlacesUnusable`.

### 5. Clear feedback when nothing changes [P9]

When the guarded patch has `changedDays.length === 0`, the server picks the first notice that applies:

| Order | Condition (code) | `notice` | de message (new key under `plan.iterate`) |
|---|---|---|---|
| 1 | `needPlacesUnusable` with no days | `places_not_loadable` | existing `placesNotLoadable` |
| 2 | a stop in scope has `s: not_found` | `stops_not_found` | `stopsNotFound`: "Es hat sich nichts geändert: {places} wurde in den Ortsdaten nicht gefunden. Bitte den Ortsnamen bei „Stopps & Zeiten“ prüfen." |
| 3 | a stop in scope has `s: error \| skipped` after step 2 of §4 | `stops_unchecked` | `stopsUnchecked`: "Es hat sich nichts geändert: Die Orte in {places} konnten noch nicht geladen werden. Sie werden im Hintergrund geladen; bitte in ein paar Minuten erneut versuchen." |
| 4 | a stop in scope has `s: cap` | `stops_capped` | `stopsCapped`: "Es hat sich nichts geändert: Für {places} lädt die App keine Orte mehr (höchstens 10 Stopps pro Reise)." |
| 5 | `tripStops(trip)` is empty, but the base plan has a stop place that is not the destination name | `stops_unknown` | `stopsUnknown`: "Es hat sich nichts geändert: Die App kennt keine Stopps dieser Reise. Trage sie unter „Stopps & Zeiten“ ein, dann gibt es auch dort konkrete Orte." |
| 6 | otherwise | none | `noChange`, followed by the model's `reply` when present |

- `PipelineData` gets `notice` (union extended) and `noticePlaces?: string[]` (up to 3 stop names; the UI joins them
  with `Intl.ListFormat`).
- Client change (`plan-iterate.tsx`): with `unchanged` and no notice, show `noChange` + " " + `reply`. Today the
  reply is dropped.
- Stop names are the user's own input shown back to them. Events carry `notice` only, never names.
- en strings get the same keys.

### 6. Budgets and quotas

- **Time (Generate).**
  - Deriving stops from the notes runs in the warm-up. Lazily it costs a parser pass, or one Haiku call
    (itinerary-upload §3) on a parser miss.
  - Geocoding is cached; cold it takes up to 4 calls of about 0.3 s per stop.
  - Stop lookups share the existing 110 s places budget beside the destination lookups.
  - The whole run stays within tags 3 + stops 5 + places 110 + ORS 10 + Sonnet 140 ≈ 268 s, under the route's 300 s
    `maxDuration`. `PLACES_BUDGET_MS` is unchanged.
- **Cap [P6].** `MAX_STOPS = 10` looked-up stops per trip, in day order; later ones get `s: "cap"`. `TripStops`
  allows 40 rows, so a 21-day trip with a port every day would otherwise mean 20+ lookups.
- **Overpass.** Without Geoapify, a stop costs 1 restaurant + 2 interest queries (25–60 s each). Inline runs never
  query Overpass for stops [P7]. The warm-up (280 s, after the destination) and the retry worker (5 jobs per run
  every 5 min, 30 min window per job) do. A cold Overpass-only trip with 4 stops (12 jobs) is complete after about 3
  worker runs.
- **Geoapify.** Per stop: restaurants 10 credits (limit 200), 2 interests at up to 15, so at most 40. 10 stops are at
  most 400 of the 2,000/day cap, and only on a cold cache (30-day TTL, shared by every trip to that town).
  `GEOAPIFY_HEADROOM` must cover one more in-flight stop lookup: raise it from 120 to 160 and update its comment
  (today 90 in flight per plan + 40).
- **ORS.** Up to 1 + 10 matrix requests per generation on a cold cache [P5] (90-day cache, shared by every trip to
  the same stop). The daily cap fails closed: when it is reached, stops just get no drive times. The cap is `ORS_DAILY_REQUESTS_DEFAULT = 200` (the 400
  in `concrete-places.md` D6 is outdated).
- **Open-Meteo geocoding.** At most 4 × 10 = 40 calls per cold trip, against 10k/day.
- **`places_pending` [P7].** Stops never make Generate answer `places_pending`. A stop in `error`/`skipped` goes into
  `pendingPlaces` as `stop:s2`, so the existing `placesIncomplete` hint shows. A retry job is enqueued, and the
  model writes the "could not be checked" note (rule 17). In a patch, an explicit `near: sN` that does not load
  answers `places_pending` as today.
- **Warm-up.** `scheduleTripWarm`: tags → derived stops (itinerary-upload [D10]) → destination facts → stops
  (Overpass allowed, remaining budget). Saving notes or stops must re-warm: today `updateTrip` (`src/lib/server/trips.ts`) schedules the warm-up only when `factsInputsChanged(before, write)`, so that check must include `notes` and `stops`.

### 7. UI, share view, PDF (checked)

- **Day card** (`src/components/plan/day-card.tsx`): stop places render like destination places: name link,
  "oder:" alternatives, "(x km Luftlinie)" when there is no drive time. The distance has no "from where" wording,
  so it stays true. The drive tooltip must say where the time is measured from: `driveTitle` stays for destination places; stop
  places get a new key `driveTitleStop` (de "Mit dem Auto ab {stop}, {km} km (OpenRouteService, geprüft am {date})",
  en "By car from {stop}, {km} km (OpenRouteService, checked {date})"). On a day whose drive times are from a stop,
  the footer uses a new `driveCreditStop` (de "Fahrzeiten: © openrouteservice.org, ab {stop}", en "Drive times:
  © openrouteservice.org, from {stop}") instead of `driveCredit` ("ab Zielort-Zentrum").
- **Day footer [P10]**: one line per day, as today. "© OpenStreetMap · geprüft am <oldest fetchedAt of the day's
  places>" is computed from the places used, so port places are credited without a change. The ORS credit appears
  when a place has `drive`, stop places included.
- **Share view** uses the same DayCard. **PDF** has one global sources line (`plan-pdf.tsx`) that already names
  OpenStreetMap. Neither needs a change.
- **Facts panel** keeps showing destination places only.
- New UI here: the §5 message keys (de + en), the `noChange` + reply change and the `fromNotes` wording. The stop
  editor belongs to itinerary-upload §4/§7.

### 8. Tokens and cost

Prices from `PRICES` (`src/lib/domain/ai.ts`), plan model: $2/M input, $10/M output, $0.2/M cache read, $2.5/M
cache write.

| Call | Today (plan-7, recorded) | With plan-8 (estimate) |
|---|---|---|
| plan system prompt | 3130 tokens | ≈ 3400 (+270: legend, rule 5 change, rule 17; one cache write ≈ +$0.0007) |
| cruise generate | 2610 in / 3536 out / 4307 read, $0.0414 | ≈ 3830 in (+120 schedule, +4 stops × ≈ 270 places) / ≈ 3800 out (refs + alts on port meals and sights), ≈ $0.047 (+14%) |
| cruise patch | 830 in / 446 out / 2606 write + 5532 read, $0.0137 | stored input +1200 tokens in the cached prefix: ≈ +$0.003 on a cold cache, +$0.0002 warm |
| stops from notes | | parser: 0; parser miss: one Haiku text call ≈ 240 µ$ (itinerary-upload §8), once per notes change |
| upgrade of an old plan in a patch (§4) | | 0 extra model calls; one cache write of the larger input |

A 7-port cruise adds about 2000 input tokens (≈ +$0.004 per generate). Today the port-restaurant request costs one
call ($0.01–0.03) or two (needPlaces) and still changes nothing. With stops it is one call that works.

### 9. Evals

Cruise fixture (`evals/fixtures/donau-kreuzfahrt.json`). Two variants: stops derived from the notes
(`scheduleNotes`), and confirmed `trips.stops` from `fixedSchedule` (itinerary-upload §9). Both must give the same
`trip.stops` rows, apart from `note` wording.
- **Geocode** (recorded): every stop resolves to a populated place in AT; Passau is within 5 km of the anchor
  (`at: "dest"` on days 1 and 5).
- **Lookups**: record restaurants and `family_activities` + `general` around Wien, Dürnstein, Melk and Linz.
- **Generate checks**:
  - `portWindows` passes on the raw output and on the stored plan (port-window guard)
  - every ref and alt on days 2–4 belongs to that day's stop, or to the destination within 10 km of it
  - no stop place appears on another day
  - each port window that covers 12:00 or 19:00 (Wien dinner, Linz lunch, Melk dinner) has a `food` activity with a
    restaurant ref of that stop
  - `stop_mismatch` and `port_window_missing` in the raw output are reported (warn, not fail)
- **Failure case**: replay with Dürnstein's lookups as `error`. Day 3 gets the "could not be checked" note for
  Dürnstein only, and Generate does not answer `places_pending`.
- **Patch** (`cruise.portpatch.json`): base = the existing plan-7 cruise generation (no `trip.stops`). Request:
  "konkrete Restaurantvorschläge für die Tage an Land in anderen Städten". Checks: the input is upgraded, there is
  one model call (no needPlaces), and days 2–4 gain restaurant refs of their stops.
- **Negative patch**: the same request on a trip without stops gives `notice: stops_unknown`, never a bare
  `noChange`.
- **Unit tests**: `extendInputWithStops`, both guards, notice selection order, the unknown-`near` change, geocoding
  fallback to any country.
- Golf and Würzburg inputs stay byte-identical (no stops). Record tokens and cost before and after, as in
  `concrete-places.md`.

## Decisions (Alex, 2026-11-11: all accepted as recommended; [P5] with drive times per stop, [P6] at 10 stops)

Shared decisions are marked with their owner. The stop model, sources and the Haiku task are decided in
itinerary-upload ([D2], [D4], [D10]); they are not repeated here.

- **[P1] Geocoding** with Open-Meteo through the existing `resolveAnchor` logic. The country is the stop's `cc`, else
  the destination's, else an exact name in any country. A stop within 5 km of the anchor counts as the destination.
  *Recommended:* keyless, cached, already verified for destination ideas. Known limit: the GeoNames point is the
  town centre, not the cruise terminal. Alternative: Geoapify geocoding (credits, a second provider for one job).
- **[P2] One plan-8 input change (shared, owned here; itinerary-upload [D6] refers to it).** It adds `trip.stops`
  (the schedule with code-set `at`) and `stopPlaces` (verified places per stop), and rule 5 reads `trip.stops`
  first. *Recommended.* Alternatives: stops as a notes-like text block (no structure for guards), or places nested
  in the schedule rows (repeats a port's lists on every day it appears).
- **[P3] Two code guards in assembly (shared, owned here):** port windows from `trip.stops` (itinerary-upload's
  proposal) and stop refs tied to their days (10 km grace for destination places, no refs on sea days, first valid
  alt as replacement). *Recommended:* the same pattern as the open-air and fixed-item guards; prompt-only ref rules
  were not reliable before (issue #142). Alternative: prompt only plus eval checks.
- **[P4] Per stop: restaurants (6), the first 2 purpose interests with a source (4 places each), cafés (3) only when
  asked; no activity groups.** *Recommended:* port windows are a few hours, and this keeps tokens and Overpass load
  small. Alternative: the full destination set per stop (≈ 3× tokens and queries).
- **[P5] Drive times for every looked-up stop:** one ORS matrix per stop, as for the destination (§2). Covers
  round trips by car; on cruises they stay hidden by default (timed-items D13). Costs up to 10 more of the 200 daily
  ORS requests on a cold cache.
- **[P6] Decided (Alex, 2026-11-11): at most 10 looked-up stops per trip, in day order;** the rest are `cap` and
  reported as not checked.
- **[P7] Stops never block Generate.** Inline runs use cache + Geoapify only, Overpass for stops runs only in the
  warm-up and the retry worker, and missing stops show the existing "places incomplete" hint. *Recommended:* 3
  Overpass queries per stop do not fit 110 s, and blocking the plan on one port is worse than one honest note.
  Alternative: `places_pending` as for destination interests (concrete-places D2).
- **[P8] Patches upgrade an old stored input with stops before the first call** (≤ 30 s, cache + Geoapify), retry
  failed stops in scope, accept stop ids as `near`, and treat an unknown `near` as unusable. *Recommended:* the
  user's request works in one model call without a regenerate. Alternatives: only via needPlaces with a stop id (a
  second call each time), or require "Plan neu erstellen".
- **[P9] Specific notices for unchanged patches (§5); otherwise the model's reply after `noChange`.** *Recommended.*
  Alternative: fixed messages only (the user loses the model's explanation).
- **[P10] One source line per day (unchanged), not one per stop.** *Recommended:* same source, same credit.
  Alternative: a credit line per stop with its own check date.

## Out of scope

Activity wishes per stop (a patch can still only load them at the destination), the cruise terminal location,
opening hours against port windows (no free source), and transport between port and town.

## Implementation notes (2026-11-11)

What the implementation found that the text above gets wrong or leaves open. The decisions [P1]-[P10] stand.

- **`StoredInput` is not "loose" for these fields.** `StoredInput` (`src/lib/server/plan-store.ts`) is a non-strict `z.object`, which strips unknown keys on read. `PlanIndexEntry.stop` and the stop points therefore have their own optional schema entries. The points of the looked-up stops are stored beside the input as `stopPoints` (like `pendingPlaces`: not hashed, not sent), because a patch needs them (`near: s1`, the retry of failed stops) and the input holds only names.
- **The hash moves with the prompt version.** §3 says the hash of a trip without stops is unchanged; it is not, because `planInputHash` includes `PLAN_PROMPT_VERSION`. The input stays byte for byte the same (golf, Würzburg and the cruise without stops are checked against their recordings), so evals verify a recording against the prompt version it was made with (`planInputHash(llm, rec.promptVersion)`). A Generate of an existing trip after the deploy makes one new version.
- **Overpass `cache_only` is not `PLACES_CACHE_ONLY`.** The budget `0` means "caches only, no Geoapify either". Stops need "caches and Geoapify, never Overpass", so `getInterestGroups`, `getRestaurantFacts` and `getCafeFacts` take `overpass: "cache_only"` as a separate option. `PLACES_CACHE_ONLY` ("generate anyway") still turns everything, stops included, into cache reads.
- **`place_retry_enqueue` takes at most 20 jobs per call** (the table was sized for one destination). A trip with stops can have more, so `enqueuePlaceRetries` sends chunks of 20.
- **`needPlacesUnusable` is set in `normalizePatch`, not where `near` is resolved.** An unknown `near` makes `resolveNeedPlaces` return `null`; the pipeline then calls `hasUnknownNear` and treats the answer as unusable (notice `places_not_loadable`).
- **Notice 5 (`stops_unknown`) needs a fixed window.** "A stop place that is not the destination name" matches the sub-area names of every ordinary trip ("Altstadt", "Residenz") and would replace the model's reply on any patch that changes nothing. The condition is: a stop of the base plan in scope with `fixed: true` (a window from notes or stops) at a place other than the destination, while the trip has no stops the app knows. Typed ports without times are not detected.
- **Notice 3 (`stops_unchecked`) also covers a failed restaurants or cafés block** (not only `s: error | skipped`), the same set the retry in §4 step 2 picks. A stop whose geocoding failed (`s: error`) counts too.
- **The notice carries stop names, not a second field.** The server answer has `notice?: { code, places: string[] }` (names of up to 3 stops, empty for codes without stops) instead of `notice` plus `noticePlaces`. With a notice there is no `reply` (it would contradict the notice); without one the `reply` is sent.
- **Geocoding is bounded at 16 names per trip** (`MAX_GEOCODED_NAMES`), not 10: names that are the destination or not found do not count as looked-up stops, so the cap of 10 looked-up stops needs a few more names. Names beyond the 16th are `cap` without a call. 4 calls per cold name still apply, so at most about 64 Open-Meteo calls per cold trip.
- **Stop restaurants and cafés carry no `ask` and no `kids` flag** (as specified), but `k` (kids-tagged) is still set on list entries when the trip's cuisine wish has `kids`.
- **Eval status.** The stop lookups (geocoding and Overpass) are recorded keyless (`npm run evals:port-places`). The Sonnet recordings (`stops`, `stopsnotes`, `stopsfail`, `portpatch`, run with `npm run evals:live`) need an Anthropic key and cost about $0.2 together; their checks (`evals/stop-checks.ts`) run on a hand-made synthetic plan until then. The notes variant uses the fixture schedule as the derived result until the extraction parser lands.
- 2026-11-12 (#188, Alex): a stop with a country hint (`cc`) but no match in that country still runs the
  any-country pass, but a namesake counts only within 500 km (`COUNTRY_MISS_MAX_KM`) of the previous stop or the
  trip anchor, with no out-of-range fallback; otherwise the stop is `not_found`. Stops without `cc` keep the
  2,500 km rule with fallback.
- 2026-11-12 (cruise from an itinerary picture): stop names as printed did not geocode. Measured on Open-Meteo:
  "Messina (Sizilien)" has no result in de/en/it, "Messina" is Messina IT PPLA2; "La Valletta" in de/en returns
  only two Italian villages (PPL), in it the Maltese capital (PPLC) first; "Valletta" in de/en is the capital.
  Changes in `resolvePlaceName` (`src/lib/server/discover/resolve-place.ts`, helpers in
  `src/lib/discover/place-name.ts`):
  - **Search name.** `cleanPlaceName` drops parentheticals and searches only the first part of "Name / Name2" and
    "Name, Region". The stop keeps the name as typed (trip form, `trips.stops`); the resolved stop shows the
    geocoded name, as before.
  - **Country after the port.** The itinerary parser and `normalizeExtract` split a trailing country ("Messina
    (Sizilien), Italien", "La Valletta, Malta") into the stop's `cc` (`src/lib/itinerary/country.ts`, names from
    `Intl.DisplayNames` de + en plus a few aliases); a `cc` the model gave wins. A parenthetical stays in the place.
  - **MT searches in Italian.** Open-Meteo has no Maltese, so `LOCAL_LANGUAGE.MT = "it"`: "La Valletta" with cc MT
    is found in the third search.
  - **One retry without a leading article** (`LEADING_ARTICLES`: la, le, il, lo, l', el, los, las, der, die, das),
    in English, when the given country has no match, or without a country when the any-country pick is missing or
    only a plain PPL. The retry's candidates count in the given country, else only within 500 km (with `cc`) or
    2,500 km (without) of the previous stop or the anchor; without a reference point they are ignored ("Las Palmas"
    must not become Palmas, BR).
  - **Feature rank in the any-country pass.** Among the exact-name candidates in range, PPLC beats PPLA* beats
    PPL before the distance and population tie-breaks (`pickNearestNamed`); the 500 km rule for a given `cc` and
    the 2,500 km rule without stay.
  - **Bound.** At most 4 searches (en, de, the country's language, the article retry) plus one by-id read per cold
    name (was 3 + 1), all through `cached()`: at most 80 Open-Meteo calls for the 16 geocoded names of a cold trip.
  - The trip form uses the same helpers to turn the first port of an upload into a picked (geo) destination
    (`pickDestinationPlace`, via `/api/geocode`): exact folded name, only the stop's country when it has one, then
    feature rank and population; at most 2 searches (the cleaned name, then without its article); free text when
    nothing matches.
  - Existing trips: the stops are geocoded again on the next Generate (or a patch that upgrades its input); a trip
    whose stops were saved with "Name, Land" gets the `cc` only when the stops are uploaded again or edited.

## Implementation notes (2026-11-12): concrete sights at the ports

A cruise in production (several ports and sea days) had restaurants with alternatives at every port, but the port sights were generic walks ("Spaziergang am Wasser", "Bummel durch die Altstadtgassen"). The patch "replace the walk by concrete sights" with no day selected changed one day only. Findings and changes:

- **Generate and patch send the same pools.** A patch sends the stored input of its base version (`patchRequest`: `inputBlock(llm)`), so its `stopPlaces` are exactly the generate request's, plus what the patch's own retry of failed stops adds. The pools were the problem, not the patch request.
- **[P4] "first 2 purpose interests" could leave a port without sights.** `interestsForTrip` puts `general` last, behind the purpose's own interests, and `stopInterests` took the first two with an OSM source. A purpose with two other interests (nature and photography, beach and hiking, …) therefore looked up no town sights at any port, on generate, in the warm-up and in the retry worker alike. Now a stop gets the town's sights (`city_sightseeing` when the purpose has it, else `general`) plus the purpose's first other interest with an OSM source: still 2 lookups per stop, same Geoapify categories as the destination's sights (inline, cache + Geoapify), so the quota estimate of §6 is unchanged. The cruise fixture keeps `family_activities` + `general`, so its recorded input is byte-identical. *Needs Alex's confirmation, as it refines a decided point.*
- **Patches fill sights for older inputs.** `prepareStopsForPatch` also looks up stops in scope whose entry lists no sights (`stopsWithoutSights`), with the current interests, cache + Geoapify only, inside the existing 30 s stop budget. A stop whose sights came back empty is a cache hit the next time. It is not a failure: notice 3 (`stops_unchecked`) does not count it.
- **A new lookup of a stop never loses data.** `extendInputWithStops` merges a re-looked-up entry with the old one (`mergeStopEntry`): old places stay (same ids), an ok restaurants or cafés block is kept when the new lookup of it failed.
- **Patch scope wording (plan-9).** With no day selected, FEEDBACK carries no `days`, and the addendum said "Otherwise change as few days as needed". It now says "change every day the request concerns (every day with the item it names, or all days when it says so) and no other", and a request for concrete places instead of generic items gives each such item a ref wherever that day's lists have a fitting unused id. The needPlaces line states that types and interests load around the destination only. About +85 tokens in the cached patch system prompt; SYSTEM_RULES and the generate input are unchanged, but `PLAN_PROMPT_VERSION` moved to `plan-9`, so the next Generate of an unchanged trip makes one new version.
- **Guards.** The stop-ref guard does not revert days: it drops a ref of another stop (or a far destination place) and keeps the activity's text, so the day still counts as changed and the drop is counted as `stop_mismatch` in `plan.patched`. The shrink guard only reverts days that lost most activities. Neither explains the report.
- **Placeholder texts.** The live eval answer gave one new sight the text "x". An activity text of one character or without any letter now counts as empty (base text, then the place name; dropped without a ref).
- **Not logged.** The model's `reply` of a patch is returned to the client but not stored (`plan_versions` has no reply column; `plan.patched` has counts only), so the reply of the reported patch cannot be looked up.
- **Eval** `portsights` (`EVAL_TASK=portsights`): the recorded `stops` generation with every port sight made generic, Alex's request with no day selected. Recorded with plan-9: days 2-5 changed, each port (Wien, Dürnstein, Melk, Linz) has a sight of its own stop, `stop_mismatch` 0, $0.0586 (2493 in, 2504 out, 11446 cache write).
