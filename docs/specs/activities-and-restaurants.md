# Activities and restaurants: real places, with alternatives (plan-4)

Status: decisions accepted by Alex 2026-11-06; groups changed to indoor/outdoor. Data layer on
`feat/activities-data`; purpose tags v2, pipeline wiring, prompt and change requests implemented on
`feat/activities-plan` (2026-11-06, see "What changed"). Follows user feedback from the live site (2026-11-06). A group-trip purpose asked for an
evening event on Friday ("escape rooms, but only an idea, suggest what the city offers"), a main event on Saturday
(rowing or footgolf, "suggest what suits the city") and restaurants for both evenings. The plan wrote
"Freitagabend-Event: Escape Room oder Kneipentour" and "Abendessen in der Innenstadt (Restaurantvorschlag)".
The change request "mache konkrete Vorschläge für Escape Rooms am Tag 1" only produced
"Escape Room, Themen: Krimi, Labor, Ausbruch". No venue was named in either case.

## Root cause

1. **The interest list has no slot for these wishes.** Haiku maps purpose text to `INTEREST_KEYS`
   (`src/lib/domain/interests.ts`). Escape rooms, footgolf, rowing and restaurants have no key, so they end up in
   `tags.custom` as free text. Custom interests never trigger a place query (`interestsForTrip`,
   `src/lib/facts/interest-sources.ts`). `nightlife` exists but has `source: "none"`.
2. **No restaurants are ever loaded.** `food_wine` covers wineries, breweries and markets only. Every meal slot is
   written without a single verified place, so the model can only describe a theme.
3. **A change request cannot load places.** `iteratePlan` reuses the stored input of the base version
   (`src/lib/server/plan-pipeline.ts`). It never fetches places, so a request for a kind of place that was not
   loaded at generation can only produce generic text. The model correctly invents nothing (ground rule 1).

The data exists. On 2026-11-06, OpenStreetMap had the following around Saarbrücken:
- 2 escape rooms (`leisure=escape_game`, 8 km)
- a rowing club, 2 boat rentals and 2 named minigolf places (25 km)
- 174 restaurants within 2.5 km of the centre:
  - 116 have a `cuisine` tag; 28 of them are `german` or `regional`
  - 106 have a website and 144 have opening hours

No footgolf was tagged within 25 km. The plan must then say so, not invent one.

## Goals

- A purpose that names an activity gets real places of that kind, if any exist nearby.
- A purpose that says "an idea, suggest what is possible" also gets real alternatives of the same sort. For an
  escape room idea that could be bowling, a cinema or laser tag (other `indoor` types). The plan shows them as the chosen
  activity plus alternatives (existing `ref` + `alts`).
- Every meal the plan suggests names real restaurants near that day's activities, filtered by the cuisine the
  purpose asks for. "Local cuisine in Germany" means German or regional places, never a pizzeria.
- A change request that asks for places the plan does not have can load them.
- No venue is ever named by the model unless code loaded it (unchanged rule 1). If nothing of a kind exists,
  the plan says that plainly, for example "no escape room found nearby in OpenStreetMap".

## Design

### 1. Activity catalogue (`src/lib/facts/activity-types.ts`, new)

This is a fixed, code-owned list of activity types. Each type has OSM filters, Geoapify categories, a group and a
default radius. It is separate from `INTEREST_KEYS`: interests describe what a trip is about and appear in the
guided purpose form, while activity types are concrete things to book. The guided form stays unchanged.

| Group | Types (OSM filter, abbreviated) |
|---|---|
| `indoor` | `escape_game` (`leisure=escape_game`), `bowling` (`leisure=bowling_alley`), `cinema` (`amenity=cinema`), `theatre` (`amenity=theatre`), `karaoke` (`amenity=karaoke_box`), `laser_tag` (`leisure=sports_centre`+`sport=laser_tag`), `climbing_hall` (`sport=climbing` + `indoor=yes`, or `sport=climbing` + `leisure=sports_centre`) |
| `outdoor` | `boat_rental` (`amenity=boat_rental`), `rowing` (`sport=rowing`), `canoe` (`sport=canoe`), `footgolf` (`sport=footgolf`), `minigolf` (`leisure=miniature_golf`), `karting` (`sport=karting`), `high_ropes` (`sport=ropes_course`), `climbing` (outdoor `sport=climbing`) |
| `going_out` | `bar` (`amenity~^(bar\|pub\|biergarten)$`) |

The split is by place, not by time of day (Alex, 2026-11-06: minigolf is rather a day activity, so a day/evening
split is debatable). The model picks the time from the trip's days, daylight and weather: an evening or a rainy
day favours `indoor`. A place tagged `indoor=yes` counts as indoor even when its type is in `outdoor` (indoor minigolf). Every filter requires a name, as today. `sport` (and other semicolon-list keys) match token-aware, e.g.
`["sport"~"(^|;)climbing(;|$)"]`, so `sport=climbing;fitness` counts. The implementer
verifies each OSM tag against the OSM wiki and drops a type whose tag is rare or ambiguous. Each kept type gets
one recorded Overpass fixture.

### 2. Purpose tags v2 (Haiku, same single cached call)

`PurposeTags` gets two optional fields. `TAGS_PROMPT_VERSION` is bumped, so each purpose is re-tagged once on its
next use; this is the existing mechanism, with no migration.

```ts
activities?: { types: ActivityType[]; open: boolean; group?: ActivityGroup }[]   // max 4 entries
cuisine?: { local: boolean; include: Cuisine[]; exclude: Cuisine[] }
```

- `activities`: one entry per wish, for example the Friday event and the Saturday event. `types` holds the
  catalogue types the text names, mapped by Haiku from the enum, and may be empty. `open` is true when the text
  says the type is only an idea or asks for suggestions.
- `cuisine`: `local` is set for "local", "regional" or "typical" food. `include` and `exclude` take OSM
  `cuisine` values from a fixed enum (about 40 common values).
- Unknown values are dropped in code, as with interests today. The free-text wish also stays in `custom`, so the
  model still sees the wording.

When `open` is true, code adds the other types of the same group (§1), so "escape room, only an idea" also loads
bowling, cinema and the other `indoor` types. If an entry has no types but `open`, code uses the group Haiku picked
(field `group` on the entry: `indoor`, `outdoor` or `going_out`). Validation: `group` is optional; an entry with
no types and no valid group is dropped (nothing to load). With types, `group` is ignored and each type's own group
is used.

### 3. Restaurants in every plan

- Restaurants are loaded by code whenever the plan has meal slots, which is always. They don't depend on the
  purpose.
- Query: `amenity=restaurant` with a name, within 2.5 km of the destination point (5 km for a `region`
  destination), cached like other places (key = point + radius).
- A per-country table `LOCAL_CUISINE` (`src/lib/facts/cuisine.ts`, new) lists the cuisine values that count as
  local. For example, `DE`: german, regional, bavarian, swabian, franconian…; `ES`: spanish, tapas, regional,
  andalusian…; `AT`: austrian, regional…. A country without an entry uses `regional` only.
- Filter:
  1. `local` and `include` are alternatives: keep restaurants whose cuisine is in the country's local set **or**
     in `include` ("local or Italian food" keeps both). With neither set (no wish, or an exclusion-only wish such
     as "no pizza"), start from all restaurants.
  2. `exclude` always drops matches.
  3. Fast-food-style cuisines (`pizza`, `burger`, `kebab`, `sandwich`, `chicken`, `fast_food`) are dropped,
     also from multi-value tags such as `german;pizza`, unless `include` or the country's local set names that
     cuisine (pizza stays local in Italy). A place also stays when `include` names one of its non-fast-food
     cuisines (`include: italian` keeps `italian;pizza`); plain `local` still drops `german;pizza`. Untagged
     restaurants are kept when no positive filter is set.
  4. If a filter leaves fewer than 3, the input marks that ("only 2 local restaurants found"), and the plan says
     so instead of padding with others.
- Ranking (no ratings exist in OSM): completeness first (website, opening_hours, cuisine tag, wikidata), then
  distance to the destination point. At most 12 restaurants go into the input; they do not count toward the 40
  activity places.
- Restaurants are loaded near the destination point only. Activities can lie up to 25 km away, and before
  generation code does not know which day uses which place, so a meal next to a far activity gets no restaurant
  ref and is written generically ("Einkehr vor Ort"), as for far stops today (`concrete-places.md` D8). A change
  request can load restaurants near a specific place (`needPlaces.near`, §4). A per-day query would multiply
  Overpass calls; it is out of scope.
- Each meal activity sets `ref` to one restaurant and `alts` to up to 2 others. The UI already renders
  "name · oder: X · Y" with links. Opening hours stay unverified, and the existing reservation and opening-hours
  hint stays.

### 4. Change requests that need places (option A)

- The patch output (`patchPlan`) gets an optional field
  `needPlaces: { types?: ActivityType[]; restaurants?: { cuisine?: …; near?: PlaceRef } }`. It is set when the
  request asks for places of a kind the input does not contain, **or** when the input has that kind but no candidate
  meets the request (for example the plan has restaurants, but none with local cuisine). `near` names a place in
  the input; restaurants are then loaded within 1.5 km of it (cache key = rounded point + radius).
- Code then fetches those places, adds them to the stored input of the new version, and runs the patch once more.
  The restaurant cache holds the nearest restaurants unfiltered, so a new cuisine wish is usually a re-filter of
  cached data, not a new query.
- The first call's other output is discarded in that case. The second call cannot request places again.
- **Budget.** Before the second call, `checkBudget(c, RESERVE_PATCH)` runs again with the first call's cost
  counted. If it blocks, the request ends with the usual budget answer and no new version.
- **Deadline.** The iterate route has `maxDuration = 300` s and the plan lock lasts `LOCK_MS` = 5 min. The whole
  request shares one deadline of 270 s from its start:
  - places get `min(60 s, remaining − 160 s)`, cache hits always served
  - the second patch call gets the remaining time minus 10 s, or is not started below 120 s
  - if places do not load in time, or too little time is left for the second call, the request answers
    `places_pending` (the existing retry prompt) without a new version; the fetch keeps warming the cache in
    `after()`, so the retry is fast
  
  The lock is released in `finally` as today and never outlives the request.
- Cost: no extra call when places are present; one more Sonnet patch call when they are missing. The request
  that triggered it takes a few seconds longer (or up to the places budget on a cold cache).

### 5. Prompt plan-4 (Sonnet)

- New input blocks `ACTIVITIES` (per purpose wish: the loaded places and the lookup status by type, and `open`)
  and `RESTAURANTS` (places, status, `tooFew`). Status is `ok`, `empty`, `error` or `skipped` (no coordinates,
  cache-only run).
- Rules:
  - An activity for a wish with places sets `ref`; with `open`, `alts` should come from other types of the group
    where possible, so the user sees different kinds of options.
  - Every lunch or dinner near the destination (the restaurant radius) with restaurants available sets
    `ref` + `alts`. A meal next to a far activity stays generic (§3).
  - Each **named** type is reported on its own: if footgolf is `empty` but rowing has places, the plan says "no
    footgolf venue listed nearby in OpenStreetMap" (the filters require a name, so unnamed entries do not count) and offers rowing. "Nothing found" is used only for an `empty` lookup;
    when a lookup failed or was skipped (free-text destination, "Generate anyway"), the plan says the places could
    not be checked. Never invent themes or venues.
- `PLAN_PROMPT_VERSION` is bumped. Existing plans keep working; new versions use plan-4.

### 6. Limits and cost

- Overpass:
  - Activity types are fetched in one query per group (union of the group's filters), not one per type.
  - All activity groups the wishes need (at most 3: `indoor`, `outdoor`, `going_out`) plus restaurants per trip, on top
    of the existing `MAX_INTEREST_QUERIES = 4`. With only three groups a cap would drop a wish; a skipped lookup
    would be reported as `skipped`, never as empty.
  - Warm-up loads them right after tagging, as for interests.
- Tokens: about 12 restaurants plus up to 16 activity places add about 800 input tokens per generation. They
  are cached together with the rest of the input.

## Decisions for Alex

- **[D1]** Activity types are a separate catalogue, not new `INTEREST_KEYS`; the guided purpose form stays as it
  is. *Accepted by Alex 2026-11-06.*
- **[D2]** `open` (an idea / suggest something) loads the whole group as alternatives. *Accepted by Alex 2026-11-06.*
- **[D3]** Restaurants are loaded for every plan, max 12, ranked by data completeness and distance. OSM has no
  ratings, so suggestions are real and nearby, not rated. *Accepted by Alex 2026-11-06.*
- **[D4]** "Local cuisine" = a per-country list of OSM cuisine values. Without a cuisine wish, fast food is
  dropped. If fewer than 3 match, the plan says so instead of showing others. *Accepted by Alex 2026-11-06.*
- **[D5]** Change requests use option A: the patch call can ask for places, code loads them, the patch runs once
  more. *Accepted by Alex 2026-11-06.*
- **[D6]** A wish with no places nearby is stated as such in the plan, never filled with themes. *Accepted by Alex 2026-11-06.*
- **[D7]** Activity groups are `indoor`, `outdoor` and `going_out`, not day/evening events. *Alex, 2026-11-06.*

## Evals

- New fixture: weekend group trip to a mid-size German city with the purpose above (no personal data).
- Checks:
  - the Friday evening activity has a ref of an `indoor` type and at least one alt of another type
  - Saturday uses an `outdoor` type (water or footgolf wish)
  - every dinner has a restaurant ref whose cuisine is in `LOCAL_CUISINE.DE` when the purpose asks for local food
  - no `pizza`/`burger` ref without a cuisine wish
  - footgolf missing is stated, not invented
- Existing golf and cruise fixtures must still pass. Record token and cost before and after, as in
  `concrete-places.md`.
- A patch eval: "make concrete escape room suggestions for day 1" on a plan generated without activity places
  triggers `needPlaces` and ends with a ref.

## What changed (`feat/activities-plan`)

- Tags `tags-2` (`purpose-tags.ts`, `TAGS_RULES`): `activities` (max 4, `{types, open, group?, label?}`) and
  `cuisine`; unknown values are dropped in code before saving. Stored v1 tags still parse. `TAGS_MAX_TOKENS`
  1500 → 3000 (one live tags-2 call ran out at 1500 with thinking).
- Facts (`facts/activity-lookups.ts`): `getTripFacts` loads restaurants, then the wish groups, one after the
  other in the places budget, in parallel with the interest lookups; warm-up gets them through the same path.
  `error` lookups make Generate answer `places_pending`, like interests; `empty` and `skipped` never block.
  Activity places also get drive times (after the interest places, in the same ORS call); restaurants do not.
- Input (`plan/activities-input.ts`): `activities` = places (`a1..`, `t`, effective `g`, `km`, `min`) + per wish
  `w`, `open` and per type `s` and ids; `restaurants` = `s`, `ask`, `tooFew`, list (`r1..`, `c`, `km`). A place
  that is already in `places` keeps its `p` id. Refs and alts validate through the shared index, so assemble,
  patches, share view and PDF need no change.
- Prompt **`plan-6`** (rules 15 and 16, patch addendum `needPlaces`). Change requests: `needPlaces` → code
  loads the places, extends the stored input (`plan/need-places.ts`: a wish labelled `FEEDBACK`, a new
  `restaurants` block, or `restaurantsNear` for `near`) and calls the patch once more with `FEEDBACK.loaded`.
  The new version keeps the extended input but the base version's `inputHash`, like every patch, so a later
  Generate can never match a patched plan.
  Events `plan.patch_need_places`, `plan.places_pending` (with `patch: true`).

Deviations:
- The prompt version is `plan-6`, not `plan-4`: `plan-4` (timed items) and `plan-5` (short activity texts) were already used.
- Wishes carry an optional `label` ("Friday evening event"), so the plan can put each wish on the right day.
- Named types get up to 4 places, the other types of an open wish up to 2, and those other types are left out when
  they have no places. Live, plan-6 otherwise reported "Karaoke: nothing found" for a wish that never named karaoke.
- An entry with only a `group` counts as open (it has nothing else to load).
- Restaurants around a place (`near`) go into an extra `restaurantsNear` block, so the destination list stays
  available for the other meals.
- Rule 15 tells the model to claim "nothing found" only for a listed `empty` type. A plan without activity
  lookups (old tags) otherwise said "no rowing or footgolf found in OpenStreetMap" without any search.

Evals (live, 2026-11-06, all checks pass). Fixture `gruppenwochenende-wuerzburg.json` (6 friends, Fri–Sun) on the
recorded Würzburg Overpass data. Interest places are not recorded for Würzburg, so only activity places and
restaurants reach the model. Day 1 had the escape room plus bowling and a climbing hall as alternatives. Day 2 had
canoeing with rowing and boat hire as alternatives, and the note said no footgolf venue is listed. Every dinner
named a Franconian or regional restaurant. The patch eval ran on a plan generated without activity places: the
first call returned `needPlaces: {types: ["escape_game"]}` and the second set the escape room ref on day 1.

| Call | Before (plan-5 / tags-1) in / out / cache | After (plan-6 / tags-2) in / out / cache | Cost before → after |
|---|---|---|---|
| system prompt | 3179 (plan), 916 (tags) | 3915 (plan), 1791 (tags) | |
| golf generate | 2309 / 2482 / 3179 write | 2302 / 2712 / 3910 write | $0.0374 → $0.0415 |
| golf patch | 726 / 467 / 5897 write | 817 / 387 / 7185 write | $0.0209 → $0.0235 |
| cruise generate | 2622 / 2349 / 3179 read | 2611 / 3546 / 3910 read | $0.0294 → $0.0415 |
| cruise patch | 831 / 545 / 2618 write + 3592 read | 965 / 551 / 2607 write + 4887 read | $0.0144 → $0.0149 |
| Würzburg generate (new) | | 2168 / 1399 / 3915 write | $0.0281 |
| Würzburg patch, 1st call (needPlaces) | | 759 / 168 / 5895 write | $0.0179 |
| Würzburg patch, 2nd call | | 766 / 536 / 1107 write + 4892 read | $0.0106 |
| tags (Würzburg) | | 206 / 1204 / 1791 read | $0.0006 |

The golf and cruise inputs are unchanged apart from the prompt; their extra cost comes from the longer system
prompt and longer answers. Rules 15 and 16 were reworded once more after the golf and cruise runs; those rules do
not apply to the two fixtures, which carry no activities or restaurants blocks (no recorded restaurant data for
Marbella and Passau).

## Out of scope

Ratings, prices and opening-hour checks (no free reliable source); booking links; multi-anchor trips
(`concrete-places.md` D8).
