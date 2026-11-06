# Activities and restaurants: real places, with alternatives (plan-4)

Status: draft for review. Follows user feedback from the live site (2026-11-06). A group-trip purpose asked for an
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
  evening event that could be escape rooms, bowling, minigolf or a cinema. The plan shows them as the chosen
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
| `evening_event` | `escape_game` (`leisure=escape_game`), `bowling` (`leisure=bowling_alley`), `minigolf` (`leisure=miniature_golf`), `cinema` (`amenity=cinema`), `theatre` (`amenity=theatre`), `karaoke` (`amenity=karaoke_box`), `laser_tag` (`leisure=sports_centre`+`sport=laser_tag`) |
| `day_event` | `boat_rental` (`amenity=boat_rental`), `rowing` (`sport=rowing`), `canoe` (`sport=canoe`), `footgolf` (`sport=footgolf`), `climbing` (`sport=climbing`), `karting` (`sport=karting`), `high_ropes` (`leisure=sports_centre`+`sport=ropes_course`), `minigolf` |
| `going_out` | `bar` (`amenity~^(bar|pub|biergarten)$`) |

A type can be in more than one group (minigolf). Every filter requires a name, as today. The implementer
verifies each OSM tag against the OSM wiki and drops a type whose tag is rare or ambiguous. Each kept type gets
one recorded Overpass fixture.

### 2. Purpose tags v2 (Haiku, same single cached call)

`PurposeTags` gets two optional fields. `TAGS_PROMPT_VERSION` is bumped, so each purpose is re-tagged once on its
next use; this is the existing mechanism, with no migration.

```ts
activities?: { types: ActivityType[]; open: boolean }[]   // max 4 entries
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
bowling, minigolf, cinema and the rest. If an entry has no types but `open`, code uses the group Haiku picked
(field `group` on the entry, enum of the three groups).

### 3. Restaurants in every plan

- Restaurants are loaded by code whenever the plan has meal slots, which is always. They don't depend on the
  purpose.
- Query: `amenity=restaurant` with a name, within 2.5 km of the destination point (5 km for a `region`
  destination), cached like other places (key = point + radius).
- A per-country table `LOCAL_CUISINE` (`src/lib/facts/cuisine.ts`, new) lists the cuisine values that count as
  local. For example, `DE`: german, regional, bavarian, swabian, franconian…; `ES`: spanish, tapas, regional,
  andalusian…; `AT`: austrian, regional…. A country without an entry uses `regional` only.
- Filter, in this order:
  1. With `cuisine.local`, keep restaurants whose cuisine is in the country's local set.
  2. With `include`, keep restaurants whose cuisine matches.
  3. `exclude` always drops matches.
  4. Without any cuisine wish, drop fast-food-style cuisines (`pizza`, `burger`, `kebab`, `sandwich`,
     `chicken`, `fast_food`) but keep untagged restaurants.
  5. If a filter leaves fewer than 3, the input marks that ("only 2 local restaurants found"), and the plan says
     so instead of padding with others.
- Ranking (no ratings exist in OSM): completeness first (website, opening_hours, cuisine tag, wikidata), then
  distance to the destination point. At most 12 restaurants go into the input; they do not count toward the 40
  activity places.
- Each meal activity sets `ref` to one restaurant and `alts` to up to 2 others. The UI already renders
  "name · oder: X · Y" with links. Opening hours stay unverified, and the existing reservation and opening-hours
  hint stays.

### 4. Change requests that need places (option A)

- The patch output (`patchPlan`) gets an optional field `needPlaces: { types: ActivityType[] | ["restaurant"],
  cuisine?: … }`, set only when the request asks for places of a kind the input does not contain.
- Code then fetches those places (same budget rules as Generate), adds them to the stored input of the new
  version, and runs the patch once more.
- The first call's other output is discarded in that case. The second call cannot request places again.
- Cost: no extra call when places are present; one more Sonnet patch call when they are missing. The request
  that triggered it takes a few seconds longer (or up to the places budget on a cold cache).

### 5. Prompt plan-4 (Sonnet)

- New input blocks `ACTIVITIES` (per purpose wish: the loaded places by type, and `open`) and `RESTAURANTS`.
- Rules:
  - An activity for a wish with places sets `ref`; with `open`, `alts` should come from other types of the group
    where possible, so the user sees different kinds of options.
  - Every lunch or dinner with restaurants available sets `ref` + `alts`.
  - A wish whose places are empty is written as "found nothing nearby in OpenStreetMap", never as invented
    themes.
- `PLAN_PROMPT_VERSION` is bumped. Existing plans keep working; new versions use plan-4.

### 6. Limits and cost

- Overpass:
  - Activity types are fetched in one query per group (union of the group's filters), not one per type.
  - At most 2 activity groups plus restaurants per trip, on top of the existing `MAX_INTEREST_QUERIES = 4`.
  - Warm-up loads them right after tagging, as for interests.
- Tokens: about 12 restaurants plus up to 16 activity places add about 800 input tokens per generation. They
  are cached together with the rest of the input.

## Decisions for Alex

- **[D1]** Activity types are a separate catalogue, not new `INTEREST_KEYS`; the guided purpose form stays as it
  is. *Proposed.*
- **[D2]** `open` (an idea / suggest something) loads the whole group as alternatives. *Proposed. Alex asked for
  alternatives 2026-11-06.*
- **[D3]** Restaurants are loaded for every plan, max 12, ranked by data completeness and distance. OSM has no
  ratings, so suggestions are real and nearby, not rated. *Proposed.*
- **[D4]** "Local cuisine" = a per-country list of OSM cuisine values. Without a cuisine wish, fast food is
  dropped. If fewer than 3 match, the plan says so instead of showing others. *Proposed. Alex: "local cuisine in
  Germany must not show pizza places", 2026-11-06.*
- **[D5]** Change requests use option A: the patch call can ask for places, code loads them, the patch runs once
  more. *Proposed (recommended; B = keyword matching, C = a picker in the change box).*
- **[D6]** A wish with no places nearby is stated as such in the plan, never filled with themes. *Proposed.*

## Evals

- New fixture: weekend group trip to a mid-size German city with the purpose above (no personal data).
- Checks:
  - the Friday evening activity has a ref of an `evening_event` type and at least one alt of another type
  - Saturday uses a `day_event` type
  - every dinner has a restaurant ref whose cuisine is in `LOCAL_CUISINE.DE` when the purpose asks for local food
  - no `pizza`/`burger` ref without a cuisine wish
  - footgolf missing is stated, not invented
- Existing golf and cruise fixtures must still pass. Record token and cost before and after, as in
  `concrete-places.md`.
- A patch eval: "make concrete escape room suggestions for day 1" on a plan generated without activity places
  triggers `needPlaces` and ends with a ref.

## Out of scope

Ratings, prices and opening-hour checks (no free reliable source); booking links; multi-anchor trips
(`concrete-places.md` D8).
