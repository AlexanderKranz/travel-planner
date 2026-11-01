# Find destinations: flight or drive

Status: accepted (Alex, 2026-11-01), all decisions D1 to D12 as recommended. Every call is listed as **[D#]** in section 11. Decisions and reasons: `docs/adr/0007-find-destinations-drive.md`.
Extends `docs/specs/find-destinations.md`, whose rules apply unless changed here. Its numbers are written "FD D7" below.

Alex's request (2026-11-01): "I cannot search for destinations without flights. I think we should add another option to say maximum driving time from home town. you should only be able to either select flight or drive."

Scope: a search by maximum driving time from a home place, verified by OpenRouteService (ORS).
Not in scope: a drive limit parsed from the purpose or a guided purpose field, telling the plan that the group arrives by car, train or ferry searches, a road route on the card.

---

## 1. Flow

Flight mode stays exactly as it is. In drive mode:

1. The form sends `travelMode: "drive"`, the limit and, if the start place differs from the profile, its `homeGeoId`.
2. Hash lookup, as today. A hit costs nothing.
3. Gates as FD section 9, plus one ORS gate right before the LLM call (section 7).
4. One Haiku call, with the home name, `travel: "drive"` and a radius hint.
5. Geocoding as today, then a straight-line cutoff with no network, then one ORS lookup per surviving place, then climate and POIs.
6. Cards show the verified drive. The trip prefill has flights off.

## 2. The control **[D1]** **[D2]**

Under the group field, a radio group "How do you travel?" with two options, **Flight** and **Drive**, side by side (`min-h-11`, two equal columns, fits 360 px). Exactly one is always selected. Each option shows only its own fields:

| Mode | Fields |
|---|---|
| Flight | Airports and flight limit, unchanged. No airports still means no distance filter, so a search with no travel context stays possible. |
| Drive | Start place and drive limit. |

**Default mode:** Flight when the profile has home airports. Otherwise Drive when the profile has a usable home (section 3). Otherwise Flight. Switching keeps the values of the other mode in the form, and only the active mode's fields are sent.

**Drive limit:** select with 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8, 10, 12 h, default 4 h, with no "No limit" entry. A limit is the only meaning of this mode, and without one ORS would be asked about places nobody can reach. Ground rule 3 holds: choosing Drive is optional, and Flight without airports remains the unfiltered search.

A flight limit in the purpose is ignored in drive mode. The form hides it and `resolveSearchParams` returns `origins: []`, `maxHours: null`.

## 3. Home coordinates **[D3]**

`profiles` gets `home_geo_id`, `home_lat`, `home_lon` (section 8). `HomeLocation` gains `geoId`, set by the picker and by `HomeSuggestionButton`. `updateProfile` resolves the coordinates server-side with `getPlaceById`, as `createTrip` does, so the browser never supplies them.

| State | Drive mode shows |
|---|---|
| Home with coordinates | Its name, with "Change" for this search |
| Home saved before this migration (name, no coordinates) | Empty picker, hint "Pick your home once more so we can measure driving time". The name cannot be resolved safely, and no backfill runs. |
| No home | Empty picker, hint "Where do you start from?" |

- The picker is `HomeLocationPicker` with a new `emptyLabel` prop. Its "Germany" default is about time zones and must never appear here.
- Picking in the form applies to this search only, like a changed airport (FD D1). A checkbox "Save as my home" sets it on the profile, and is ticked by default only when no usable home exists. It is explicit because the home also drives the time difference line.
- Without a start place the submit button is disabled with the hint visible; the server answers `home_required`. Flight stays available.
- The server resolves `homeGeoId` through `getPlaceById`. A failed lookup is `places_unavailable`.
- Saved name and coordinates are copied to the search row, so "Show others" uses the same start even if the home changes later.
- The model gets the home name, as it gets airport cities today. Coordinates go to ORS only, never to the model. The share read path selects none of the new columns.

## 4. Radius hint and authoritative check **[D4]**

New pure module `src/lib/drive/estimate.ts`:

```ts
export const DRIVE_HINT_KM_PER_H = 90;     // straight-line progress of a typical long drive
export const DRIVE_CUTOFF_KM_PER_H = 120;  // beyond this no real drive gets there
export const DRIVE_TOLERANCE_MIN = 10;     // same idea as LIMIT_TOLERANCE_MIN
export const driveHintRadiusKm = (h: number) => Math.round(h * DRIVE_HINT_KM_PER_H);
export const driveCutoffKm = (h: number) => Math.round(h * DRIVE_CUTOFF_KM_PER_H);
```

| Limit | Hint to Haiku | Cutoff in code |
|---|---|---|
| 2 h | 180 km | 240 km |
| 4 h | 360 km | 480 km |
| 8 h | 720 km | 960 km |
| 12 h | 1,080 km | 1,440 km |

Three levels, cheapest first:
1. **Hint:** `radiusKm` in the model input. It only shapes the ideas.
2. **Cutoff (`assessDrive`, no network):** haversine from home to anchor above the cutoff drops `too_far`. It only saves ORS calls and must never decide a close case.
3. **ORS drive time: the authoritative check.** A place passes when `min <= 60 * limit + DRIVE_TOLERANCE_MIN`.

Both speeds are starting values from general knowledge of European roads, not measurements. The spike (section 5) checks them on real pairs. The distance is measured to the anchor town, so the far edge of a region can lie beyond the limit (FD D8).

**Model input.** `IdeaInput` keeps `v: 1` and gains two optional fields, both absent in flight mode:

```ts
travel?: "drive";     // sent to the model
homeCell?: string;    // "50.11,8.68": hash only, stripped in ideasRequest like fromIata
```

In drive mode `from` = `[homeName]`, `fromIata` is absent and `radiusKm` is the hint. `buildIdeaInput` no longer takes `from` from origins alone.

**`IDEAS_RULES`:** `from` is reworded to "where the trip starts" (airport cities, or the home place). New rule: "If travel is drive, the group goes by car from from. Propose only places reachable by road without a ferry, and no islands without a road link." The schema does not change.

**Filters in code:**
- `mentionsFlight` also strips drive limits, for example "4 Stunden Autofahrt", "max. 3 h Fahrt", "4 h drive". Words like "scenic drives" stay.
- `REASON_BANNED` gains `ferry|ferries`, whole-word `(auto)fähre(n)`, and `\p{L}+stunden` after a number. "ungefähr" must survive.

## 5. Verifying the drive **[D5]** **[D6]** **[D7]**

**ORS routes over ferries, and the matrix does not say so.** A matrix time within the limit may contain a crossing: Marbella to Palma (15 h) only fails on length, and a shorter crossing would pass a 12 h limit. So the search asks for a route that excludes ferries.

**The lookup:** one ORS Directions request per place, driving-car, with `options: { avoid_features: ["ferries"] }`. New `fetchDriveRoute(from, to)` in `openrouteservice.ts`, new `getDriveRoute` in `src/lib/server/facts/drive-route.ts`.

```ts
type DriveRoute = { road: true; min: number; km: number } | { road: false };
```

- **Cache per place pair**, `cacheKey("route", 1, { lat, lon, geoId })`, origin at 3 decimals, 90 days (`DRIVE_TTL_SECONDS`). A matrix key hashes the whole destination list and would almost never hit again. This key is reused by every later search from the same town, also across users, because it holds only two public places and no owner.
- **"No road" is a cached result,** not an error, so an island is asked once.
- **Position in the pipeline:** first step of `verifyOne`, before climate. A place out of range must not use one of the 5 climate misses (FD D9). The loop stops at 5 cards, so usually 5 or 6 requests are sent, at most 8. Concurrency stays 2. It counts against the 45 s budget.
- **`postJson` throws `HttpError` with the status only.** ORS reports "no route" as an error response, so the client must read the error code from the body. Otherwise an island is indistinguishable from an outage.
- `parseMatrix` and `MAX_DRIVE_MIN = 180` stay untouched. Plan drive times work as before.

| ORS answer | Result |
|---|---|
| Route within limit | Card, with the road `min` and `km` |
| Route over limit | Drop `too_far` |
| No route without ferries (error code from the spike) | Drop `no_road` |
| Start or end not routable, timeout, 5xx, quota | Drop `drive_failed`, never a real negative |

**Islands and ferries.** No island list is needed: ferry-only places fail by themselves, and bridged ones (Rügen, Krk) pass. A home on an island reaches that island only. Ferry-only places are dropped, not shown with a warning, because "drivable" is what the user asked for. Britain and Ireland from the continent will probably drop too; the spike shows how ORS treats the Channel Tunnel.

**Spike before the build (integrations-dev, about 8 live ORS calls on the free tier, no cost).** The ORS docs site was down on 2026-10-28, so none of this is confirmed yet:

| # | Call | Must show |
|---|---|---|
| S1 | Directions with `avoid_features`, Frankfurt → Marbella | A route. Long routes with this option may be refused by a server distance limit. |
| S2 | Same, Marbella → Palma | No route, and its exact error code |
| S3 | Same, Hamburg → Copenhagen | A road route, not the Puttgarden ferry |
| S4 | Same, Frankfurt → London | How the Channel Tunnel behaves |
| S5 | Same, Stralsund → Sassnitz | A bridged island passes |
| S6 | Matrix with `options.avoid_features` | Accepted and honoured, or refused |
| S7 | 2 or 3 further pairs | Times fit the constants in section 4 |

**Spike result (2026-11-01, 7 calls to the live API, ORS engine 9.10.0, key valid).** The first run returned 403 for every call because the script cut the key at its own `=`; the repeat below is the real result. Recorded bodies: `src/lib/integrations/__fixtures__/openrouteservice/`.

| # | Result |
|---|---|
| S1 | Frankfurt to Marbella: HTTP 200, 1314 min, 2343 km. No server distance limit with `avoid_features`. |
| S2 | Marbella to Palma: HTTP 404, `error.code` **2009** ("Route could not be found"). This is the `no_road` code. Answered in 0.16 s. |
| S3 | Hamburg to Copenhagen: HTTP 200, 284 min, 472 km, a road route (the Puttgarden ferry is not used). |
| S4 | Frankfurt to London: HTTP 404, code 2009. The Channel Tunnel is not routed, so Britain and Ireland drop as `no_road`, as expected. **It took 9.8 s**, against 0.1 to 0.2 s for every other call. |
| S5 | Stralsund to Sassnitz: HTTP 200, 57 min, 52 km (Rügen has a bridge). |
| S6 | Matrix with `options.avoid_features`: the option is accepted, but the request fails as a whole with HTTP 500, code 6020 ("Search exceeds the limit of visited nodes"), for a batch with an unreachable pair. A batch cannot be used, so Directions stays. |
| S7 | Frankfurt to Munich 209 min, 392 km (straight line 87 km/h); Frankfurt to Marseille 551 min, 1007 km (86 km/h); Hamburg to Berlin 163 min, 288 km (94 km/h). |

Consequences:
- S1 works and S6 does not help, so the build is as written: one Directions request per place.
- The constants fit: the fastest straight-line progress seen is 94 km/h (hint 90, cutoff 120). Hamburg to Copenhagen is 61 km/h because the ferry-free road goes around, which the cutoff tolerates.
- Only code 2009 on HTTP 404 is `no_road`. Other errors (2010 "no routable point", 429, 5xx, timeout) are `drive_failed`.
- **Deviation: the Directions timeout is 20 s, not the matrix's 10 s,** because a long no-route answer took 9.8 s (S4). At 10 s such a place would count as a failure, and two of them in a row stop the search with `drive_unavailable`.
- **Quota differs from the spec's assumption.** The Directions response headers say `x-ratelimit-limit: 200` with a 24-hour window, not a bucket larger than the matrix's roughly 500. `ORS_DAILY_REQUESTS` (default 400) counts matrix and Directions calls together, so it can allow more Directions calls than ORS does. Over the real limit ORS answers 429, which is `drive_failed` and, after two in a row, `drive_unavailable`: the search degrades safely, but the gate before the LLM call may let a search start that cannot finish. The default of `ORS_DAILY_REQUESTS` is therefore 200. The gate (8 + 50 left) leaves 142 requests for searches and at least 50 for plans.

Two outcomes change the build, and nothing else does:
- **S6 works:** use one matrix request per round instead of Directions, with a `maxMin` parameter on `parseMatrix` (default 180) and the existing `driveCacheKey`. Everything else in this spec stays. `getDriveRoute` hides the difference from `verify.ts`. I do not expect this: as far as I remember, the matrix API has no such option.
- **S1 fails:** drop `avoid_features` and request `extra_info: ["waytype"]`. A route with a ferry segment becomes `no_road`. Cost: a mainland place whose fastest route uses a ferry is dropped.

## 6. Cards and trip prefill **[D8]** **[D9]**

```ts
drive: z.object({
  min: z.number().int(), km: z.number(),
  source: z.literal("openrouteservice"), fetchedAt: z.string(), stale: z.boolean(),
}).nullable().optional(),   // absent on saved flight cards
```

**`.optional()` is required.** `rowToSearch` falls back to `[]` when `SuggestionCards` fails to parse, so a required field would silently empty every saved list.

Drive cards have `flight: null`, `nearAirport: false`.

- The drive is an API fact, so it goes in the **Checked** block: "ca. 3.5 h drive from Frankfurt am Main · 345 km, no ferries", with source openrouteservice and check date.
- **The Estimate block is hidden** when `card.drive` is set.
- Time uses the half-hour rounding of `roundedFlightMin` (renamed `roundedHalfHourMin`), at least 30 min. The largest allowed value, limit + 10 min, rounds down to the limit, so a card never shows more than the limit (FD section 3).
- Pills on the list: start place and drive limit instead of airports and flight limit.
- Footer: `list.footerDrive` replaces `footerFlights`: times come from road data without traffic or breaks, and ferries were not counted.
- Empty list: `list.widenDrive`. Drop lines: `too_far` currently says "flight limit", so drive mode uses `drops.too_far_drive`, plus `drops.no_road` ("{count} only reachable by ferry") and `drops.drive_failed`.

**Prefill.** `buildTripDraft` gets `travelMode` and in drive mode sets `wantsFlights: false`, `originAirports: []`. `title` and `notes` stay empty (FD D11), and the drive is not copied into the trip. The user can still switch flights on in the form. This already follows from empty origins today; the explicit guard and a test keep it that way.

## 7. Quota and failures **[D10]**

| Provider | Cold round in drive mode |
|---|---|
| ORS | up to 8 requests, usually 5 or 6; a list with 2 rounds at most 16 |
| Others | As FD D9, AeroDataBox still 0 |

`assertOrsQuota` counts every ORS call in `api_calls`, so the Directions requests share `ORS_DAILY_REQUESTS` (default 200, the Directions limit measured in the spike) with plans. It moves to a shared place and gains `orsRequestsLeft()`. The cap is deliberately kept as the one guard. With the gate below, searches can use 142 of the 200 requests and plans keep at least 50.

**New gate before the LLM call, rounds 1 and 2:** the key is set and `orsRequestsLeft() >= 8 + ORS_PLAN_RESERVE` (50). Otherwise `drive_unavailable`, so no Haiku call is spent on a search that cannot be verified. Plans keep a reserve, and an unreadable count fails closed.

| Failure | Behaviour |
|---|---|
| Saved list for the same input | Served as usual, ORS not needed |
| Key missing, quota nearly used | `drive_unavailable` before the LLM call. Flight remains usable. |
| ORS fails during verification (2 failures with no success yet) | Stop asking. `failed` with `drive_unavailable`, the same exception as geocoding in FD section 9. |
| One place fails, others work | That place is not shown, counted `drive_failed` |
| 3 failures in a row after an earlier success | Stop asking. The places not reached count as `drive_failed`; cards found so far stay. |
| Any `drive_failed` in the list | The list is served for one hour only (not 30 days), so an identical search runs again. Anchors never checked stay out of the "Show others" exclusions. |
| ORS down, cached value exists | `cached()` serves it with `stale: true`, and the card shows the stale pill |
| All places drop | `done` with 0 cards, counts, "Show others" |

**This is a deliberate exception to FD D7, which keeps cards as "Not checked".** A climate gap leaves a useful card. An unchecked drive would show exactly what the user excluded, an unreachable island for example. So `drive` has no `not_checked` state, and every drive card carries a verified time.

`drive_unavailable` is added to `ActionError`, to `ERROR_CODES` in `store.ts` (otherwise it reads back as `failed`) and to `errors.*`. Event `destination.searched` gains `travelMode` and `driveLookups`, never place names.

## 8. Schema and hash **[D11]**

Migration `20261107120032_destination_search_drive.sql`:

**`profiles`**

| Column | Type | Null | Note |
|---|---|---|---|
| `home_geo_id` | integer | yes | |
| `home_lat` | double precision | yes | `between -90 and 90` |
| `home_lon` | double precision | yes | `between -180 and 180` |

- Check `profiles_home_coords`: the three are all null or all set, and set only with `home_location`.
- Add the three to the `update` column grant.
- `updateProfile` clears them when the home is cleared.

**`destination_searches`**

| Column | Type | Null | Default | Note |
|---|---|---|---|---|
| `travel_mode` | text | no | `'flight'` | `check in ('flight','drive')`; existing rows become flight |
| `max_drive_hours` | numeric(3,1) | yes | | `between 1 and 12` |
| `home_name` | text | yes | | `<= 120`, snapshot |
| `home_lat`, `home_lon` | double precision | yes | | ranges as above, snapshot |

- Check `destination_searches_mode_shape`. Flight: all four drive columns null. Drive: all four set, `cardinality(origins) = 0`, `max_flight_hours is null`.
- `radius_km` holds the hint in drive mode.
- **Add the new columns to both the `insert` and the `update` column grants.** `claimRound1` updates a reused row, so an insert-only grant fails on the second run. RLS, indexes and retention are unchanged.

```ts
// DestinationSearchInput gains
travelMode: z.enum(["flight", "drive"]).default("flight"),   // an open old tab keeps working
maxDriveHours: z.number().min(1).max(12).multipleOf(0.5).optional(),
homeGeoId: z.number().int().positive().optional(),           // absent = profile home
saveHome: z.boolean().default(false),
// refine: drive requires maxDriveHours and forbids origins and maxFlightHours;
// flight forbids maxDriveHours, homeGeoId and saveHome
```

`DROP_REASONS` gains `no_road`, `drive_failed`. `DestinationSearch` gains `travelMode`, `maxDriveHours`, `homeName`; coordinates stay out of the view.

**Hash.** It stays the sha256 of the whole `IdeaInput`, so mode, limit (through `radiusKm`) and home (through `from` and `homeCell`) are covered. Two towns named Neustadt differ by `homeCell`. A flight input and a drive input can never collide because of `travel`.

**`IDEAS_PROMPT_VERSION` goes to `ideas-3`,** because the rules changed. Same-input flight searches miss the 30-day cache once and cost one Haiku call each.

**Existing saved searches stay valid:**
- `v` stays 1. `rowToSearch` discards any other value, which would break "Show others".
- Rows stay in the list and open by id. The old hash just no longer matches, and the unique index allows old and new side by side.
- The old `input` has no `travel`, so "Show others" on an old row runs as flight, with the `travel_mode` default to match.
- Old cards parse because `drive` is optional, and new drop keys are additive.

**Order (runbook section 1):** the migration-only PR first, wait for "Deploy database migrations" to go green, then the app PR, because `SEARCH_COLUMNS` and the profile `COLUMNS` select the new columns.

## 9. Tests **[D12]**

**Pure units:**
- `driveHintRadiusKm` and `driveCutoffKm` at the table values; `assessDrive`; the limit + 10 min boundary; half-hour rounding, never above the limit, minimum 30 min.
- `buildIdeaInput` in drive mode: `from` = home, `travel` set, no `fromIata`, flight input byte-identical without the new fields.
- `ideasRequest`: `homeCell` and `fromIata` never reach the model.
- Hash differs by mode, limit, `homeCell`.
- `mentionsFlight` strips "4 Stunden Autofahrt", keeps "scenic drives".
- `REASON_BANNED` catches "mit der Fähre", keeps "ungefähr".
- Prefill: drive gives `wantsFlights: false`, empty origins, empty notes.
- Zod refine for each forbidden mix; an input without `travelMode` is flight.
- An old saved card without `drive` parses.

**ORS client, recorded fixtures from the spike:** route, no-route body, error body, timeout, ferries in the request. `parseMatrix` still drops 921 min.

**`verifyIdeas` with mocked `drive`:**

| # | Case | Must hold |
|---|---|---|
| T1 | Frankfurt, 4 h, Munich and Marseille | Munich card with a drive, Marseille cut with no ORS call |
| T2 | Mallorca idea, any limit | `no_road`, no climate miss used, not `too_far` |
| T3 | Bridged island idea | Card stays |
| T4 | Limit 12 h, 11 h 50 route | Passes although over `MAX_DRIVE_MIN` |
| T5 | All lookups fail | Stops after 2, `drive_unavailable`, nothing shown |
| T6 | One lookup fails | Others stay, count `drive_failed` |
| T7 | Second search, same town and place | Cache hit, no ORS call |
| T8 | 5 cards reached | No further ORS call |
| T9 | Any drive path | No `integrations/aerodatabox` import, review test stays green |

**Pipeline:** gate before the LLM call means 0 Haiku calls when the quota is short; a saved list is served with ORS down; round 2 uses the row's start after the profile home changed; a purpose flight limit is ignored in drive mode.

**pgTAP:** B cannot read A's coordinates; `mode_shape` rejects mixed rows; a user session can update the new columns on a reused row; profile coordinates check.

**UI:** exactly one mode selected; default mode rules; legacy home shows the picker; both modes at 360 px; the `de` and `en` keys match. Playwright comes later, as everywhere.

## 10. Delivery

**i18n,** namespace `discover`: `form.{travelMode,modeFlight,modeDrive,start,startNew,startRepick,saveHome,driveLimit,driveLimitHint,driveLimitHours}`, `card.{driveFacts,driveUnder30}`, `list.{pillStart,pillDriveLimit,footerDrive,widenDrive}`, `drops.{too_far_drive,no_road,drive_failed}`, `errors.{drive_unavailable,home_required}`.

| Area | Files |
|---|---|
| Migration | Migration 32, `supabase/tests/rls.test.sql` |
| Domain | `destination-search.ts`, `profile.ts`, `result.ts`, `ai.ts` (`ideas-3`) |
| Pure | `src/lib/drive/estimate.ts` (new), `src/lib/discover/{input,reason,prefill}.ts`, `src/lib/plan/prompt.ts`, `src/lib/flights/estimate.ts` (rename) |
| Server | `integrations/openrouteservice.ts`, `integrations/http.ts` (error body), `server/facts/drive-route.ts` (new), `server/facts/drive-times.ts` (quota moves), `server/discover/{verify,pipeline,store}.ts`, `server/ai/destination-ideas.ts`, `server/profile.ts` |
| UI | `discover-form.tsx`, `suggestion-card.tsx`, `discover-results.tsx`, `helpers.ts`, `home-location-picker.tsx`, `home-suggestion`, discover `page.tsx` (home passed in) |
| Ops, docs | `scripts/demo/reset.mjs` (seed a home, so the demo can try drive mode), privacy text if it lists ORS data, `docs/architecture.md`, `CLAUDE.md` below |

**Proposed wording for CLAUDE.md ground rule 2,** the destination ideas bullet. This needs Alex's approval. Replace "derived by code from the flight limit" with "derived by code from the flight or drive limit". Everything else stays.

## 11. Decisions to review

- **[D1] Radio group Flight or Drive, always exactly one.** Default Flight when the profile has airports, else Drive when a usable home exists, else Flight.
- **[D2] Drive limit 1 to 12 h, default 4 h, no "No limit" entry.** Flight without airports stays the unfiltered search.
- **[D3] Home coordinates on `profiles`, resolved by the server from `geoId`.** No backfill: old homes are picked again. No home means an inline picker, for this search unless "Save as my home" is ticked. Drive never falls back to Germany.
- **[D4] Hint 90 km/h, code cutoff 120 km/h straight line, ORS decides** with a 10-minute tolerance. Starting values, checked in the spike.
- **[D5] One Directions request per place, ferries excluded, cached per place pair.** Usually 5 or 6 requests per round. One matrix request replaces it only if the spike shows the matrix honours the option.
- **[D6] Ferry-only places are dropped as `no_road`, with no island list.** Islands with a bridge pass.
- **[D7] Spike first, about 8 free ORS calls.** It decides the exact request and the "no route" code.
- **[D8] The drive is a Checked fact with source and date,** and the Estimate block is hidden. Half-hour rounding, as for flights.
- **[D9] Trip prefill has flights off,** and nothing about the drive is copied into the trip.
- **[D10] No "Not checked" for drive.** ORS failure means no card, an exception to FD D7, plus a gate before the LLM call that keeps 50 requests for plans.
- **[D11] Additive schema, `travel_mode` default `flight`, `v` stays 1, `ideas-3`.** Old lists stay valid; each same-input flight search misses the cache once.
- **[D12] Tests as section 9.** CI needs no network: ORS answers are recorded in the spike or mocked.
