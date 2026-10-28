# Phase 2 spec: trips & destination facts

Status: proposed (architect, 2026-10-28, written overnight; defaults marked **[D#]** are listed in section 13 for Alex to review).
Decisions and reasons: `docs/adr/0002-phase-2-trips-facts.md`. Conventions from `docs/specs/phase-1-data-model.md` section 1 apply unchanged (private schema, explicit grants, `(select auth.uid())`, DB + Zod limits, snake_case DB / camelCase TS).

Scope: `trips` table and CRUD, destination geocoding, facts (climate, daylight, country, destination summary, candidate places), `api_cache`, `api_calls`, trips UI, demo seed.
Not in phase 2: plan generation and snapshots (phase 3), flights (phase 4, only `wants_flights` + `origin_airports` are stored now), admin views (phase 6), short-range forecast, plug types **[D10]**, driving times (ORS, phase 3).

---

## 1. Migrations (new files, forward-only)

Existing files use timestamp prefixes (`20261028120010_…`). New:

| # | File | Content |
|---|---|---|
| 11 | `supabase/migrations/20261029120011_api_cache.sql` | `api_cache` table, index, RLS on, no grants |
| 12 | `supabase/migrations/20261029120012_api_calls.sql` | `api_calls` table, indexes, admin-read RLS |
| 13 | `supabase/migrations/20261029120013_trips.sql` | `unique (id, owner_id)` on `trip_purposes`; `trips` table, checks, composite FKs, indexes, grants, RLS, `updated_at` trigger |

No RPCs: every write is a single-row insert/update/upsert.

---

## 2. Tables

### 2.1 `trips`

| Column | Type | Null | Default | Constraint / note |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `owner_id` | uuid | no | `auth.uid()` | FK `auth.users`, cascade |
| `title` | text | yes | — | `char_length between 1 and 120`; null = UI shows a generated fallback (not stored) |
| `dest_kind` | text | no | — | `check (dest_kind in ('city','region','freetext'))` |
| `dest_name` | text | no | — | display name, `char_length between 1 and 120`. For geocoded destinations defaults to the place name but the user may rename it ("Costa del Sol") **[D2]** |
| `dest_place_name` | text | yes | — | geocoded name of the anchor place (e.g. "Marbella"), `<= 120` |
| `dest_geo_id` | bigint | yes | — | Open-Meteo/GeoNames id of the anchor place |
| `dest_country_code` | text | yes | — | `check (dest_country_code ~ '^[A-Z]{2}$')`; optional also for freetext **[D3]** |
| `dest_admin1` | text | yes | — | region/state from geocoding, `<= 120` |
| `dest_lat` | double precision | yes | — | `check (dest_lat between -90 and 90)` |
| `dest_lon` | double precision | yes | — | `check (dest_lon between -180 and 180)` |
| `dest_timezone` | text | yes | — | IANA zone from geocoding (e.g. `Europe/Madrid`), `<= 64` |
| `dest_radius_km` | smallint | yes | — | `check (dest_radius_km between 1 and 200)`; null = default by kind (city 15, region 40) **[D2]** |
| `length_days` | smallint | no | — | `check (length_days between 1 and 60)` **[D5]** |
| `start_date` | date | yes | — | `check (start_date between '2000-01-01' and '2100-12-31')` |
| `months` | smallint[] | no | `'{}'` | candidate travel months (alternatives, not a span) **[D4]**; `check (cardinality(months) <= 12 and months <@ array[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[])`; sorted + unique enforced in Zod |
| `group_id` | uuid | yes | — | composite FK below |
| `purpose_id` | uuid | yes | — | composite FK below |
| `wants_flights` | boolean | no | `true` | used in phase 4 **[D6]** |
| `origin_airports` | text[] | no | `'{}'` | override; empty = profile `home_airports`. Same check as `profiles.home_airports` (≤ 5, `^[A-Z]{3}$`) |
| `notes` | text | yes | — | trip-specific free text (ship name, port list, …), `<= 2000` **[D7]** |
| `created_at`, `updated_at` | timestamptz | no | `now()` | `private.set_updated_at()` trigger |

Integrity (in the `create table`):
```sql
-- same-owner references; deleting a group/purpose clears only the reference column (PG >= 15)
foreign key (group_id, owner_id)   references public.travel_groups (id, owner_id) on delete set null (group_id),
foreign key (purpose_id, owner_id) references public.trip_purposes (id, owner_id) on delete set null (purpose_id),

-- destination shape
constraint trips_dest_geo check (
  (dest_kind = 'freetext'
     and dest_lat is null and dest_lon is null and dest_geo_id is null and dest_place_name is null
     and dest_admin1 is null and dest_timezone is null and dest_radius_km is null)
  or
  (dest_kind in ('city','region')
     and dest_lat is not null and dest_lon is not null and dest_geo_id is not null and dest_place_name is not null)
),
-- timing: exact date OR months OR nothing
constraint trips_timing_exclusive check (start_date is null or cardinality(months) = 0)
```
Before the table: `alter table public.trip_purposes add constraint trip_purposes_id_owner_key unique (id, owner_id);` (target of the composite FK; `travel_groups` already has it).

Indexes: `(owner_id, updated_at desc)`; `(group_id) where group_id is not null`; `(purpose_id) where purpose_id is not null` (FK actions on delete).

Grants and RLS (standard owner policies from phase 1, column grants so `owner_id`/`id` can never be written):
```sql
alter table public.trips enable row level security;
revoke all on table public.trips from anon, authenticated, public;
grant select, delete on public.trips to authenticated;
grant insert (title, dest_kind, dest_name, dest_place_name, dest_geo_id, dest_country_code, dest_admin1,
              dest_lat, dest_lon, dest_timezone, dest_radius_km, length_days, start_date, months,
              group_id, purpose_id, wants_flights, origin_airports, notes) on public.trips to authenticated;
grant update (<same list>) on public.trips to authenticated;
-- + the four "trips: owner select/insert/update/delete" policies (template in phase-1 spec §1)
```
Per-user cap: 30 trips, checked in the server action (business rule, not DB) **[D8]**.

Retention: a trip is deleted 18 months after the later of its last update and its end date (exact dates only). A nightly pg_cron job (`private.purge_expired_trips()`, migration 014) deletes expired trips and logs `trips.purged` with the count only **[D19]**.

Phase 3 fit: `plan_versions` (phase 3) will reference `trips(id, owner_id)` the same way and store a **snapshot** `{ trip, group (resolved ages at the reference date), purpose, facts: TripFacts }`. Nothing on `trips` is snapshot data; `trips` holds live references only. `TripFacts` (section 6) is designed to be stored verbatim in that snapshot.

### 2.2 `api_cache` (server-only)

| Column | Type | Null | Default | Note |
|---|---|---|---|---|
| `provider` | text | no | — | `check (provider ~ '^[a-z0-9_]+$')`; allowed values = Zod `CacheProvider` |
| `cache_key` | text | no | — | normalized key, see 4.2; `char_length <= 500` |
| `payload` | jsonb | no | — | **already reduced/aggregated** data, never raw large responses; `check (pg_column_size(payload) < 262144)` |
| `fetched_at` | timestamptz | no | `now()` | shown in the UI as the check date |
| `expires_at` | timestamptz | no | — | |
| | | | | PK `(provider, cache_key)` |

Index: `(expires_at)` for cleanup. RLS enabled, `revoke all on public.api_cache from anon, authenticated, public;`, **no grants, no policies**: only the secret key (`service_role`) reads/writes. Not user-readable, not even by admins (keys may contain search text and coordinates).
Expired rows are kept and served as **stale** when a refresh fails; cleanup (phase 6 cron) deletes rows with `expires_at < now() - interval '180 days'`.

### 2.3 `api_calls` (monitoring)

| Column | Type | Null | Default | Note |
|---|---|---|---|---|
| `id` | bigint identity | no | — | PK |
| `created_at` | timestamptz | no | `now()` | |
| `provider` | text | no | — | same values as `api_cache.provider` |
| `endpoint` | text | no | — | logical name, `check (endpoint ~ '^[a-z0-9_]+$')`, e.g. `search`, `archive`, `interpreter`, `summary` |
| `cache` | text | no | — | `check (cache in ('hit','miss','stale','bypass'))` (`stale` = expired entry served because the refresh failed) |
| `status` | smallint | yes | — | HTTP status of the upstream call; null on hit or network error/timeout |
| `ok` | boolean | no | — | |
| `latency_ms` | integer | yes | — | upstream latency (null on hit) |
| `units` | integer | yes | — | quota units if the provider counts them (Open-Meteo weighted calls, AeroDataBox units) |
| `quota_remaining` | integer | yes | — | from response headers when available (AeroDataBox, phase 4) |
| `error_code` | text | yes | — | short class only (`timeout`, `http_429`, `zod`, `network`), `<= 60` |
| `user_id` | uuid | yes | — | `references auth.users(id) on delete set null`; null for cron/demo-seed |

No cache key, query text or coordinates in this table (admins see it; privacy rule).
Indexes: `(created_at desc)`, `(provider, created_at desc)`.
RLS: enabled; `revoke all … from anon, authenticated, public; grant select … to authenticated;` policy `"api_calls: admin select" using ((select private.is_admin()))`. No insert policy (secret key writes). Retention 90 days (phase 6 cron).

---

## 3. Data sources (exact endpoints, TTLs, quotas)

All calls from server code only, `User-Agent: TravelPlanner/1.0 (+<APP_URL>; <INTEGRATIONS_CONTACT>)` (new server-only env var `INTEGRATIONS_CONTACT`, an email address; required by Wikimedia and Overpass etiquette). Default timeout 8 s (Overpass 30 s). Every response validated with Zod.

| Fact | Provider id | Endpoint | Cache TTL | Quota / etiquette |
|---|---|---|---|---|
| Geocoding search | `open_meteo_geocoding` | `GET https://geocoding-api.open-meteo.com/v1/search?name={q}&count=8&language={de\|en}&format=json` | 30 d | Open-Meteo free: 10k calls/day, 5k/h, 600/min, non-commercial. Route requires login, ≥ 2 chars, client debounce 300 ms |
| Geocoding by id | `open_meteo_geocoding` | `GET https://geocoding-api.open-meteo.com/v1/get?id={geoId}&language={de\|en}` | 365 d | search results also prime this key (no extra call on save) |
| Climate normals | `open_meteo_archive` | see 3.1 | 365 d | weighted ~130 calls per new location, once per location/year |
| Daylight | — (code) | `suncalc` | not cached | none |
| Country facts | — (static) | `src/data/countries.json`, built from REST Countries (3.3) | rebuilt yearly | no runtime calls |
| Destination summary | `wikivoyage` | see 3.4 | 30 d (not found: 7 d) | Wikimedia: UA required, serial requests |
| Candidate places | `overpass` | see 3.5 | 30 d (empty result also cached 30 d) | max 2 parallel slots/IP, < 10k queries/day: **serialize**, no retries on 429/504 within a request |

Errors are never cached. On error: serve the stale entry if one exists (`cache='stale'`), else the fact is `unavailable` with `reason: 'provider_error'`.

### 3.1 Climate: Historical Weather API, aggregated in code **[D1]**
```
GET https://archive-api.open-meteo.com/v1/archive
  ?latitude={lat2}&longitude={lon2}
  &start_date=2016-01-01&end_date=2025-12-31
  &daily=temperature_2m_max,temperature_2m_min,precipitation_sum,sunshine_duration
  &timezone=auto
```
- `lat2`/`lon2` = coordinates rounded to 2 decimals (~1 km; the reanalysis grid is 9–25 km, so this only improves cache sharing).
- Period is a constant `CLIMATE_PERIOD = { from: 2016, to: 2025 }` in `src/lib/facts/climate.ts` (10 full years). Changing it changes the cache key (`v` bump).
- Aggregation (pure, `aggregateClimate(daily) → MonthlyClimate[12]`): per calendar month across all years: mean of daily max, mean of daily min, mean monthly precipitation total, mean count of days with `precipitation_sum >= 1 mm`, mean sunshine hours/day (`sunshine_duration / 3600`). One decimal. Only the 12-row aggregate (~1.5 KB) is cached, never the 3,653-day raw response.
- `units` logged = `ceil(4/10 × 3653/14)` = 105 (Open-Meteo weights calls by variables and days).
- Why not the Climate API (`climate-api.open-meteo.com/v1/climate`): it serves CMIP6 model **projections**, which are not constrained by observations and carry model bias; the archive (ERA5 / ERA5-Land / IFS reanalysis) is observation-based. Both are free; the archive call is bigger but happens once per location per year.
- Selected months: the cache holds all 12 months; the facts layer marks `selectedMonths` (exact date → months touched by `start_date … start_date + length_days - 1`; months mode → those months; none → empty = 12-month overview).

### 3.2 Daylight (code, no API)
`suncalc` (`npm i suncalc @types/suncalc`), `src/lib/facts/daylight.ts`:
- Dates: exact date → each trip day, if `length_days <= 14`, else first, every 7th, and last day; months mode → the 15th of each selected month in its reference year (section 5); none → the 15th of all 12 months.
- Per date: `sunrise`, `sunset`, `dusk` (civil dusk = "dark from"), `daylightMinutes`. Times are UTC ISO instants; the UI formats them with `timeZone = dest_timezone`. Polar day/night → times null + `polar: 'day' | 'night'`.
- Needs coordinates and a timezone, so freetext destinations get `unavailable('no_location')`.

### 3.3 Country facts: static dataset from REST Countries **[D9]**
- `scripts/countries/build.mjs` (`npm run countries:build`, run about yearly, like airports) calls
  `GET https://restcountries.com/v3.1/all?fields=cca2,name,capital,currencies,languages,timezones,idd,car` (8 fields; `/all` requires `fields`, max 10)
  and writes `src/data/countries.json`: `{ source, fetchedAt, countries: { [cca2]: { nameEn, capital[], currencies[{code,symbol}], languages[iso639_3], callingCodes["+34"], drivingSide, timezones["UTC+01:00"] } } }`.
- `src/lib/integrations/countries.ts`: `getCountry(cca2)`, in-memory, server-only.
- UI localizes names with `Intl.DisplayNames` (region, currency, language). If a 3-letter language code does not localize, fall back to the English name from the dataset (stored as `languageNamesEn`).
- Time zone shown from `dest_timezone` (IANA) with the UTC offset on the reference dates computed by `Intl`, not from the REST list (which has fixed offsets without DST); the REST list is shown only when the country spans several zones.
- **Plugs/voltage: omitted in phase 2 [D10].** `CountryFacts.plugs` exists in the contract and is always `null` for now.

### 3.4 Destination summary: Wikivoyage
```
GET https://{lang}.wikivoyage.org/w/api.php?action=query&format=json&formatversion=2
  &generator=geosearch&ggscoord={lat}|{lon}&ggsradius=10000&ggslimit=5
  &prop=extracts|coordinates|info&exintro=1&explaintext=1&exsentences=3&inprop=url&redirects=1
```
`lang` = user locale. Pick the page whose title equals `dest_place_name` (accent-insensitive), else the nearest page within 5 km, else `not_found` **[D11]**. Cache key `summary:v1:lang={lang};geo={geoId}`. Output: `{ title, extract (≤ 600 chars), url, lang }`. Shown verbatim with CC BY-SA attribution. **Not** passed to the LLM in phase 3 (share-alike and tokens); phase 3 may pass the title + URL only.

### 3.5 Candidate places: Overpass (OSM)
```
POST https://overpass-api.de/api/interpreter        (env OVERPASS_URL overrides; no automatic mirror failover)
data=[out:json][timeout:25];
(
  {one line per filter of the interest, each with (around:{radiusM},{lat},{lon})}
);
out center tags 150;
```
- One query **per interest key** (cache shared across trips and users). Cache key `interpreter:v1:interest={key};lat={lat3};lon={lon3};r={radiusKm}` (3 decimals).
- Radius: `max(trip radius ?? kind default, mapping.minRadiusKm ?? 0)`, capped at 60 km.
- Post-processing in code (`src/lib/facts/places.ts`, pure): drop unnamed elements, dedupe by name + 200 m, compute distance (haversine), rank by (`wikidata` present, `wikipedia` present, distance), keep top 25. Only the trimmed candidates are cached.
- Calls inside one request run sequentially; a module-level in-flight map dedupes identical keys.

### 3.6 Interest key → source mapping
Static table `INTEREST_SOURCES` in `src/lib/facts/interest-sources.ts`. `wd` = element must have a `wikidata` tag (notability filter for broad categories).

| Interest key | Source | Overpass filters (each `nwr`, all require `["name"]`) | minRadiusKm |
|---|---|---|---|
| `golf` | osm | `["leisure"="golf_course"]` | 40 |
| `beach` | osm | `["natural"="beach"]` | — |
| `hiking` | osm | `["tourism"="viewpoint"]`, `["natural"="peak"]["wikidata"]` | 25 |
| `city_sightseeing` | osm | `["tourism"~"^(attraction\|viewpoint)$"]["wikidata"]`, `["historic"~"^(castle\|monument\|city_gate\|fort)$"]["wikidata"]`, `["building"="cathedral"]["wikidata"]` | — |
| `museums` | osm | `["tourism"~"^(museum\|gallery)$"]` | — |
| `architecture` | osm | `["building"~"^(cathedral\|church\|palace)$"]["wikidata"]`, `["historic"="castle"]["wikidata"]` | — |
| `history` | osm | `["historic"~"^(castle\|ruins\|archaeological_site\|fort\|monument)$"]["wikidata"]` | — |
| `food_wine` | osm | `["craft"~"^(winery\|brewery)$"]`, `["amenity"="marketplace"]` | — |
| `wellness` | osm | `["amenity"="public_bath"]`, `["leisure"="sauna"]` | — |
| `family_activities` | osm | `["tourism"~"^(zoo\|aquarium\|theme_park)$"]`, `["leisure"="water_park"]` | 25 |
| `nature_wildlife` | osm | `["leisure"="nature_reserve"]["wikidata"]`, `["boundary"="national_park"]` | 40 |
| `cycling` | osm | `["amenity"="bicycle_rental"]` | — |
| `skiing` | osm | `["landuse"="winter_sports"]` | 60 |
| `shopping` | osm | `["shop"~"^(mall\|department_store)$"]`, `["amenity"="marketplace"]` | — |
| `photography` | osm | `["tourism"="viewpoint"]` | — |
| `water_sports` | osm | `["leisure"="marina"]`, `["sport"~"^(scuba_diving\|surfing\|kitesurfing\|sailing)$"]` | — |
| `christmas_markets` | osm, **experimental** | `["xmas:feature"="market"]` (sparse, mostly DE/AT). If it returns nothing for Passau/Wien in the fixture check, switch to `none` **[D12]** | — |
| `nightlife` | none | no notability signal in OSM | — |
| `cruise` | none | ports/times come from the user (trip notes) | — |
| `festivals_events` | none | date-bound, no reliable open source | — |
| custom text interests | none | until phase 3 Haiku tags map them to keys | — |

Rules: interests come from `purpose.guided.interests` (known keys only). No purpose or no known interest → the pseudo key `general` = the `city_sightseeing` filters. Keys with source `none` appear in `PlacesFacts.groups` with `status: 'no_source'`, so the UI can say "no verified source, the AI plan will suggest without facts" and phase 3 knows to flag such suggestions as unverified. Max 4 interest queries per trip (first 4 in purpose order) **[D13]**.

### 3.7 Attribution (shown per fact block and on a static `/[locale]/sources` page)

| Source id | Shown as | License / required text | Link |
|---|---|---|---|
| `open_meteo` | "Open-Meteo (ERA5 2016–2025)" | CC BY 4.0; also "Contains modified Copernicus Climate Change Service information" | https://open-meteo.com/ |
| `geonames` | "GeoNames via Open-Meteo" | CC BY 4.0 | https://www.geonames.org/ |
| `osm` | "© OpenStreetMap contributors" | ODbL 1.0, must link the copyright page | https://www.openstreetmap.org/copyright |
| `wikivoyage` | "Wikivoyage: {title}" | CC BY-SA 4.0, link article + license | article URL, https://creativecommons.org/licenses/by-sa/4.0/ |
| `rest_countries` | "REST Countries" | MPL-2.0 project, data as of build date | https://restcountries.com/ |
| `suncalc` | "computed (suncalc)" | no UI attribution needed | — |

Static table `SOURCES` in `src/lib/facts/sources.ts` (id → homepage, license, licenseUrl, i18n label key). Every fact block ends with `<SourceNote>`: source label + link, "checked {date}" (from `fetchedAt`, formatted in the UI), plus "may be outdated" when `stale`.

---

## 4. Server module layout and ownership

### 4.1 Files
```
src/lib/domain/trip.ts                 Zod TripInput, types Trip, TripTiming, Destination      (backend-dev, step 0)
src/lib/domain/facts.ts                types TripFacts, Fact<T>, SourceId, …                    (backend-dev, step 0, verbatim from §6)
src/lib/domain/geo.ts                  type GeoPlace (geocoding result)                         (backend-dev, step 0)

src/lib/server/trips.ts                "use server": list/get/create/update/deleteTrip          (backend-dev)
src/lib/server/api-cache.ts            cached() + key helpers, writes api_calls                 (backend-dev)
src/lib/server/api-calls.ts            logApiCalls(rows[]) batched insert, never throws         (backend-dev)

src/lib/integrations/http.ts           fetchJson/postForm with timeout, UA, returns {status, latencyMs, body}   (integrations-dev)
src/lib/integrations/open-meteo-geocoding.ts   searchPlaces(q, lang), getPlaceById(id, lang) → GeoPlace          (integrations-dev)
src/lib/integrations/open-meteo-archive.ts     fetchDailyHistory(lat, lon, period) → DailySeries                 (integrations-dev)
src/lib/integrations/overpass.ts       buildQuery(filters, center, radiusM), parseElements(json) → RawOsmElement[] (integrations-dev)
src/lib/integrations/wikivoyage.ts     fetchSummary(lat, lon, placeName, lang) → DestinationSummary | null        (integrations-dev)
src/lib/integrations/countries.ts      getCountry(cca2) from src/data/countries.json                             (integrations-dev)
scripts/countries/build.mjs, src/data/countries.json                                                              (integrations-dev)

src/lib/facts/trip-timing.ts           referenceDates(trip, today), selectedMonths(trip)  (pure)  (integrations-dev)
src/lib/facts/climate.ts               CLIMATE_PERIOD, aggregateClimate()                 (pure)  (integrations-dev)
src/lib/facts/daylight.ts              daylightFor(lat, lon, dates)                        (pure)  (integrations-dev)
src/lib/facts/places.ts                rankCandidates(), haversineKm()                    (pure)  (integrations-dev)
src/lib/facts/interest-sources.ts      INTEREST_SOURCES, interestsForTrip()               (pure)  (integrations-dev)
src/lib/facts/sources.ts               SOURCES                                            (pure)  (integrations-dev)

src/lib/server/facts/weather.ts        getWeatherFacts(trip, ctx)     uses cached()               (integrations-dev)
src/lib/server/facts/daylight.ts       getDaylightFacts(trip, ctx)                                 (integrations-dev)
src/lib/server/facts/country.ts        getCountryFacts(trip, ctx)                                  (integrations-dev)
src/lib/server/facts/summary.ts        getSummaryFacts(trip, ctx)                                  (integrations-dev)
src/lib/server/facts/places.ts         getPlacesFacts(trip, purpose, ctx)                          (integrations-dev)
src/lib/server/facts/index.ts          getTripFacts(trip, purpose, ctx), warmTripFacts(...)        (integrations-dev)

src/app/api/geocode/route.ts           GET ?q=&lang=                                               (integrations-dev)
```
Every file under `src/lib/server/` starts with `import "server-only"` (actions: `"use server"`).

### 4.2 Cache contract (`src/lib/server/api-cache.ts`)
```ts
export const CacheProvider = z.enum(["open_meteo_geocoding", "open_meteo_archive", "overpass", "wikivoyage", "aerodatabox"]);
export type CacheProvider = z.infer<typeof CacheProvider>;

/** Stable key: `${endpoint}:v${version}:` + params sorted by name, `k=v` joined by `;`.
 *  Strings: NFC, trim, lowercase, collapse spaces. Numbers: as given (round coords before calling). */
export function cacheKey(endpoint: string, version: number, params: Record<string, string | number>): string;

export type FetchOutcome<T> = { data: T; status: number; latencyMs: number; units?: number; quotaRemaining?: number };

export type CachedResult<T> =
  | { ok: true; data: T; fetchedAt: string; stale: boolean; cache: "hit" | "miss" | "stale" }
  | { ok: false; error: "provider_error" | "timeout" | "invalid_response" };

export type CacheCtx = { userId: string | null };

export async function cached<T>(opts: {
  provider: CacheProvider;
  endpoint: string;               // logged to api_calls
  key: string;                    // from cacheKey()
  ttlSeconds: number;
  schema: z.ZodType<T>;           // re-validates the cached payload; a mismatch counts as a miss
  fetcher: () => Promise<FetchOutcome<T>>;   // throws on non-2xx / timeout / Zod error
  ctx: CacheCtx;
}): Promise<CachedResult<T>>;
```
Behaviour: read row → fresh: return `hit`; missing/expired → call `fetcher` → upsert with `fetched_at = now()`, `expires_at = now() + ttl` → `miss`; fetcher throws and an expired row exists → return it with `stale: true` (`cache='stale'`); otherwise `{ok:false}`. Exactly one `api_calls` row per `cached()` call. Uses the secret-key admin client. Never throws.

### 4.3 Facts context
```ts
export type FactsCtx = CacheCtx & { locale: Locale; today: string /* YYYY-MM-DD, Europe/Berlin */ };
```

### 4.4 Loading strategy
- Facts are **not** stored per trip. The detail page computes them from `api_cache` on every view (cheap: warm cache = a few primary-key reads).
- Each facts panel is an async server component inside its own `<Suspense>`; a slow Overpass call never blocks the page. Trip detail page sets `export const maxDuration = 60`.
- On create/update (destination, timing or purpose changed) the server action calls `after(() => warmTripFacts(trip, purpose, ctx))` (`next/server`) to fill the cache in the background.

---

## 5. Trip timing rules (pure, `src/lib/facts/trip-timing.ts`)
- `date`: reference dates = `start_date … start_date + length_days - 1`; ages use `start_date`.
- `months`: for each month, the 15th of its **next occurrence** on or after the current month (Europe/Berlin "today"); ages use the earliest of these dates **[D4]**.
- `none`: no reference date; ages shown "today"; weather = 12-month overview; daylight = 15th of each month in the current year.
Group ages on the detail page: `resolveGroupAges(group.entries, ageDate, profile.birthdate)` (existing, `src/lib/group.ts`).

---

## 6. Contracts (TypeScript)

### 6.1 `src/lib/domain/geo.ts`
```ts
export type GeoPlace = {
  geoId: number;
  name: string;                 // localized per request language
  featureCode: string;          // GeoNames, e.g. "PPLA2", "ADM1"
  countryCode: string | null;   // ISO 3166-1 alpha-2
  admin1: string | null;
  lat: number;
  lon: number;
  timezone: string | null;      // IANA
  population: number | null;
  suggestedKind: "city" | "region";   // PPL* -> city, everything else -> region
};
```
Route `GET /api/geocode?q=mar&lang=de` → `{ results: GeoPlace[] }` (max 8). 401 when not signed in, 400 when `q` < 2 or > 80 chars, `Cache-Control: private, max-age=3600`. Errors → `{ results: [], error: "unavailable" }` with 200 so the form falls back to free text.

### 6.2 `src/lib/domain/trip.ts`
```ts
export const MAX_TRIP_DAYS = 60;
export const MAX_TRIPS_PER_USER = 30;
export const DEFAULT_RADIUS_KM = { city: 15, region: 40 } as const;

export const Month = z.number().int().min(1).max(12);

export const TripTimingInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("date"), startDate: IsoDate }),
  z.object({ kind: z.literal("months"), months: z.array(Month).min(1).max(12)
              .transform((m) => [...new Set(m)].sort((a, b) => a - b)) }),
  z.object({ kind: z.literal("none") }),
]);

/** The client sends only the geocoding id; the server resolves coordinates via getPlaceById (cached). */
export const DestinationInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["city", "region"]),       // z.union of two literals in code
    geoId: z.number().int().positive(),
    name: optionalText(120),                // custom display name; default = place name
    radiusKm: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal("freetext"),
    name: z.string().trim().min(1).max(120),
    countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  }),
]);

export const TripInput = z.object({
  title: optionalText(120),
  destination: DestinationInput,
  lengthDays: z.number().int().min(1).max(MAX_TRIP_DAYS),
  timing: TripTimingInput.default({ kind: "none" }),
  groupId: z.string().uuid().nullable().default(null),
  purposeId: z.string().uuid().nullable().default(null),
  wantsFlights: z.boolean().default(true),
  originAirports: HomeAirports.default([]),   // reuse the profile schema; isKnownIata checked server-side
  notes: optionalText(2000),
});
export type TripInput = z.input<typeof TripInput>;

export type TripTiming =
  | { kind: "date"; startDate: string }
  | { kind: "months"; months: number[] }
  | { kind: "none" };

export type Destination =
  | { kind: "city" | "region"; name: string; placeName: string; geoId: number; countryCode: string | null;
      admin1: string | null; lat: number; lon: number; timezone: string | null; radiusKm: number /* default applied */ }
  | { kind: "freetext"; name: string; countryCode: string | null };

export type Trip = {
  id: string;
  title?: string;
  destination: Destination;
  lengthDays: number;
  timing: TripTiming;
  groupId: string | null;
  purposeId: string | null;
  wantsFlights: boolean;
  originAirports: string[];      // as stored; empty = use profile
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type TripSummary = Pick<Trip, "id" | "title" | "destination" | "lengthDays" | "timing" | "updatedAt"> & {
  groupName: string | null;
  purposeName: string | null;
};
```
Server actions (`src/lib/server/trips.ts`, all return `ActionResult`, same style as `purposes.ts`):
```ts
listTrips(): Promise<ActionResult<TripSummary[]>>          // embeds travel_groups(name), trip_purposes(name)
getTrip(id): Promise<ActionResult<Trip>>
createTrip(input: TripInput): Promise<ActionResult<Trip>>  // resolves geoId, checks isKnownIata, cap, logs trip.created
updateTrip(id, input: TripInput): Promise<ActionResult<Trip>>   // logs trip.updated
deleteTrip(id): Promise<ActionResult>                       // logs trip.deleted
```
New `ActionError` values: `"unknown_place"` (geoId cannot be resolved), `"limit_reached"`.
A `groupId`/`purposeId` of another user fails the composite FK (23503) → map to `"not_found"`.
`app_events` props: `{ tripId, destKind, timingKind, lengthDays, hasGroup, hasPurpose }` only.

### 6.3 `src/lib/domain/facts.ts`
```ts
export type SourceId = "open_meteo" | "geonames" | "osm" | "wikivoyage" | "rest_countries" | "suncalc";

export type Fact<T> =
  | { status: "ok"; data: T; source: SourceId; sourceUrl?: string;
      fetchedAt: string;   // ISO timestamp; for computed facts = computation time; for static data = dataset date
      stale: boolean }
  | { status: "unavailable"; reason: "no_location" | "no_country" | "not_found" | "provider_error"; source?: SourceId };

export type MonthlyClimate = {
  month: number;          // 1..12
  tMaxC: number; tMinC: number;
  precipMm: number;       // mean monthly total
  wetDays: number;        // mean days with >= 1 mm
  sunshineHours: number;  // mean hours per day
};
export type WeatherFacts = {
  months: MonthlyClimate[];           // always 12
  selectedMonths: number[];           // empty = overview
  period: { from: number; to: number };
};

export type DaylightDay = {
  date: string;                        // YYYY-MM-DD
  sunrise: string | null; sunset: string | null; dusk: string | null;   // UTC ISO instants
  daylightMinutes: number;
  polar?: "day" | "night";
};
export type DaylightFacts = { timezone: string; basis: "trip_dates" | "mid_month"; days: DaylightDay[] };

export type CountryFacts = {
  code: string;
  nameEn: string;
  capital: string[];
  currencies: { code: string; symbol?: string }[];
  languages: { code: string; nameEn: string }[];   // ISO 639-3 as delivered
  callingCodes: string[];                           // "+34"
  drivingSide: "left" | "right";
  timezone: { iana: string | null; utcOffsets: string[]; countryZones: string[] };  // offsets on reference dates, e.g. "+01:00"
  plugs: null;                                      // phase 2: always null [D10]
};

export type DestinationSummary = { title: string; extract: string; url: string; lang: string };

export type InterestOrGeneral = InterestKey | "general";
export type PlaceCandidate = {
  osmType: "node" | "way" | "relation";
  osmId: number;
  name: string;
  names: Partial<Record<"de" | "en", string>>;   // from name:de / name:en
  category: string;                               // matched tag, e.g. "leisure=golf_course"
  lat: number; lon: number;
  distanceKm: number;                             // from the destination anchor, 1 decimal
  wikidata?: string;
  wikipedia?: string;                             // "de:Passauer Dom"
  website?: string;
  osmUrl: string;                                 // https://www.openstreetmap.org/{type}/{id}
};
export type PlaceGroup =
  | { interest: InterestOrGeneral; status: "ok"; candidates: PlaceCandidate[]; fetchedAt: string; stale: boolean }
  | { interest: InterestOrGeneral; status: "empty"; fetchedAt: string; stale: boolean }
  | { interest: InterestOrGeneral; status: "no_source" }
  | { interest: InterestOrGeneral; status: "error" };
export type PlacesFacts = { radiusKm: number; groups: PlaceGroup[]; customInterests: string[] };

export type TripFacts = {
  tripId: string;
  generatedAt: string;
  referenceDates: string[];
  weather: Fact<WeatherFacts>;
  daylight: Fact<DaylightFacts>;
  country: Fact<CountryFacts>;
  summary: Fact<DestinationSummary>;
  places: Fact<PlacesFacts>;   // outer fetchedAt = oldest group fetchedAt
};
```
Facts functions (all never throw):
```ts
getWeatherFacts(trip: Trip, ctx: FactsCtx): Promise<Fact<WeatherFacts>>
getDaylightFacts(trip: Trip, ctx: FactsCtx): Promise<Fact<DaylightFacts>>       // sync work, async for symmetry
getCountryFacts(trip: Trip, ctx: FactsCtx): Promise<Fact<CountryFacts>>         // freetext without country -> no_country
getSummaryFacts(trip: Trip, ctx: FactsCtx): Promise<Fact<DestinationSummary>>
getPlacesFacts(trip: Trip, purpose: TripPurpose | null, ctx: FactsCtx): Promise<Fact<PlacesFacts>>
getTripFacts(trip, purpose, ctx): Promise<TripFacts>     // phase 3 snapshot input
warmTripFacts(trip, purpose, ctx): Promise<void>
```

---

## 7. UI (frontend-dev)

Routes under `src/app/[locale]/app/`:
| Route | Content |
|---|---|
| `trips/page.tsx` | List of `TripCard`s (title or fallback, destination, timing summary, length, group/purpose chips), "New trip" button, empty state. Becomes the first nav item; `/app` links to it |
| `trips/new/page.tsx` | `TripForm` (create) |
| `trips/[id]/page.tsx` | `TripHeader` (title, destination, timing, length, edit, delete with `ConfirmDialog`), `TripContext` (group with ages via `resolveGroupAges`, purpose name + interest chips, origin airports or "home airports"), facts panels each in `<Suspense fallback={<FactSkeleton/>}>` |
| `trips/[id]/edit/page.tsx` | `TripForm` (edit) |
| `src/app/[locale]/sources/page.tsx` | static attribution/licences page (public) |

Components `src/components/trips/`:
- `trip-form.tsx`: fields in this order, only destination and length required: destination, length (number stepper 1–60), timing, title (placeholder shows the fallback), group select ("none" + list), purpose select ("none" + list), "Show flights" toggle, origin airports (collapsed: "use my home airports" checked by default; unchecking shows the existing `AirportPicker`), notes (collapsed).
- `destination-picker.tsx`: accessible combobox (`role="combobox"`, listbox, keyboard), calls `/api/geocode` with 300 ms debounce, ≥ 2 chars; result rows "Name, admin1, country" (country via `Intl.DisplayNames`); last row always "Use “{q}” as free text". After selection: kind toggle city/region (preset from `suggestedKind`), radius select for region (10/25/40/60/100), editable display name. Free text: optional country select (codes from `countries.json` via a small server-provided list prop).
- `timing-field.tsx`: segmented control "Date / Month(s) / Not yet"; date input; 12 month chips (multi-select, 3×4 grid at 360 px).
- `trip-card.tsx`, `trip-header.tsx`, `trip-context.tsx`, `trip-title.ts` (pure `fallbackTitle(trip, t, locale)` → "Passau · Dez. · 7 Tage").
- `src/components/facts/`: `weather-table.tsx` (rows = months, cols = max/min °C, rain mm, wet days, sun h; selected months bold, "show all 12" disclosure; horizontal scroll at 360 px), `daylight-table.tsx` (date, sunrise, sunset, dark from, hours), `country-card.tsx` (definition list), `summary-card.tsx` (extract + "read more on Wikivoyage"), `places-list.tsx` (one section per interest: name (localized), category label, distance, links OSM/Wikipedia/website; `no_source` and `error` texts), `source-note.tsx`, `fact-skeleton.tsx`, `fact-unavailable.tsx` (per `reason`).
- Panel loaders (async server components) live next to the page: `trips/[id]/_panels/*.tsx`, each calling one `get*Facts`.

i18n: new namespaces `trips.*`, `facts.*`, `sources.*`, `interests.*` (exists) in `messages/de.json` and `messages/en.json`, same keys. Category labels per OSM tag `facts.category.<key>_<value>`. No hardcoded strings, dates/times/numbers formatted with `next-intl` formatters (`timeZone` for daylight).

Mobile: single column at 360 px, tables scroll horizontally inside their card, touch targets ≥ 44 px (`min-h-11`), facts panels stack; desktop: two columns for facts (`lg:grid-cols-2`).

---

## 8. Demo seed (`scripts/demo/reset.mjs`, backend-dev)
- Wipe `trips` for the demo user before groups/purposes (order irrelevant thanks to `set null`, but keeps logs clean).
- Add `guided: { v: 1, interests: ["christmas_markets", "cruise", "city_sightseeing"], pace: "relaxed" }` to the cruise purpose and `guided: { v: 1, interests: ["golf"], rooms: "single_rooms" }` to the golf purpose.
- Two trips (destinations hard-coded with values from the recorded geocoding fixtures, so the script needs no API call):
  1. "Advents-Donaukreuzfahrt": `dest_kind 'city'`, Passau (DE, `Europe/Berlin`), `length_days 7`, `months {12}`, group "Familie mit Kleinkind", purpose "Advents-Flusskreuzfahrt", `wants_flights false`, notes "Passau – Wien – Budapest – Passau".
  2. "Golf an der Costa del Sol": `dest_kind 'region'`, display name "Costa del Sol", anchor Marbella (ES, `Europe/Madrid`), `radius_km 40`, `length_days 5`, `months {3}`, group "Golf-Duo", purpose "Golftrip", `wants_flights true`.
- No real dates (months only, so they always point to the next December/March). Facts warm on first view.

---

## 9. Test plan

Unit (Vitest, next to the code, recorded fixtures in `src/lib/integrations/__fixtures__/<provider>/`, no network in CI):
- Fixtures to record once (integrations-dev, trimmed, no headers): `open-meteo/geocoding-search-passau-de.json`, `geocoding-search-marbella-en.json`, `geocoding-search-empty.json`, `geocoding-get-<id>.json`, `open-meteo/archive-malaga-2016-2025.json` (full; it is the aggregation golden input; if > 300 KB, keep 2 years and a separately computed expected output), `overpass/golf-marbella-40km.json`, `overpass/general-passau-15km.json`, `overpass/xmas-passau.json`, `overpass/error-429.txt`, `wikivoyage/geosearch-passau-de.json`, `wikivoyage/geosearch-none.json`.
- `climate.test.ts`: aggregation (month boundaries, leap days, wet-day threshold, rounding, missing values = null days skipped); expected Málaga March ≈ 19–20 °C max.
- `daylight.test.ts`: Passau 2026-12-15 dusk ≈ 16:40 local; polar day at Tromsø in June; DST day.
- `trip-timing.test.ts`: next-occurrence rule incl. December → January rollover, current month, date mode spanning two months.
- `interest-sources.test.ts`: every `INTEREST_KEYS` entry has a mapping (compile-time `Record<InterestKey, …>` + test); query builder output snapshot.
- `places.test.ts`: dedupe, ranking, unnamed dropped, top-25 cut.
- Client tests: Zod rejects malformed responses; `cacheKey` normalization (accents, case, param order).
- `api-cache.test.ts` (mock Supabase admin client): hit, miss, stale-on-error, schema mismatch → refetch, exactly one `api_calls` row per call.
- `trip.test.ts` (domain): `TripInput` accepts destination+length only; rejects date+months, month 13, length 0/61; freetext without country ok.
- `trips.test.ts` (server, mocked session): geoId resolution, 23503 → `not_found`, limit.

pgTAP (`supabase/tests/rls.test.sql`, qa-reviewer):
- user B cannot select/update/delete A's trips; anon has no access.
- `owner_id`/`id` not updatable by `authenticated` (column grants).
- trip with B's `group_id`/`purpose_id` inserted by A fails (23503).
- deleting a group/purpose sets `trips.group_id`/`purpose_id` to null and keeps `owner_id`.
- checks: freetext with coordinates rejected; city without coordinates rejected; date + months rejected; month 13 rejected; `length_days` 0 rejected.
- `api_cache`: no select/insert for `authenticated` (including admin) and `anon`.
- `api_calls`: non-admin selects 0 rows, admin can select, nobody but service_role inserts.

E2E (later, phase 6): create trip with destination+length only → detail page shows weather and daylight.

---

## 10. Task split (parallel, fixed contract)

**Step 0 (backend-dev, first commit, ~30 min, blocks nobody for long):** create `src/lib/domain/{trip,facts,geo}.ts` verbatim from section 6, export them from `src/lib/domain/index.ts`, add `unknown_place` and `limit_reached` to `ActionError`, and add stubs in `src/lib/server/trips.ts` and `src/lib/server/facts/index.ts` that return typed fixtures. Contract changes after step 0 go through the architect.

| Agent | Owns (writes) | Depends on |
|---|---|---|
| **backend-dev** | migrations 11–13; `src/lib/domain/{trip,facts,geo}.ts`, `result.ts` (new errors); `src/lib/server/trips.ts`; `src/lib/server/api-cache.ts`, `api-calls.ts`; `scripts/demo/reset.mjs`; `INTEGRATIONS_CONTACT`/`OVERPASS_URL` in `.env.example`; tests for these | `getPlaceById` signature (§4.1) for createTrip; may stub it until integrations lands |
| **integrations-dev** | everything in `src/lib/integrations/` (new files), `src/lib/facts/*`, `src/lib/server/facts/*`, `src/app/api/geocode/route.ts`, `scripts/countries/build.mjs`, `src/data/countries.json`, fixtures, `suncalc` dependency; tests for these; verifies the open points marked "verify" (Wikivoyage TextExtracts, `xmas:feature` density, `era5` coverage at the fixtures) | `cached()` signature (§4.2): mock it in tests until backend-dev lands |
| **frontend-dev** | `src/app/[locale]/app/trips/**`, `src/app/[locale]/sources/page.tsx`, `src/components/trips/*`, `src/components/facts/*`, nav link, `messages/{de,en}.json` keys `trips.*`, `facts.*`, `sources.*` | step-0 types and stubs; fixtures for visual states |
| **qa-reviewer** | pgTAP additions in `supabase/tests/rls.test.sql`; review of all three; check no LLM call was added | migrations 11–13 |

Merge order: backend-dev migrations + cache → integrations → frontend (each behind green CI). `npm test`, `lint`, `typecheck` before reporting done.

---

## 11. Environment variables (server-only)
| Var | Purpose |
|---|---|
| `INTEGRATIONS_CONTACT` | contact email in the User-Agent (Wikimedia/Overpass policies) |
| `OVERPASS_URL` | optional, default `https://overpass-api.de/api/interpreter` |
No API keys are needed in phase 2 (Open-Meteo free tier, Overpass, Wikivoyage are keyless).

---

## 12. Risks
- **Overpass from Vercel**: shared egress IPs can hit the per-IP slot limit (429) independent of our load. Mitigation: long TTL, stale serving, sequential calls, `OVERPASS_URL` override; candidates are an optional panel.
- **Open-Meteo free tier is non-commercial** (same condition as AeroDataBox Basic): fine for family and friends; a commercial use needs the paid API key (`customer-` hosts).
- **Region modelling** is a point + radius; rivers/coasts are approximated. Multi-stop trips (cruise ports) are phase 3 (itinerary), not a phase 2 data concern.
- Wikivoyage geosearch may pick a district article; the 5 km rule and title match limit this.

---

## 13. Decisions taken overnight (please review)

Each item is implemented as described unless Alex changes it.

- **[D1] Climate source = Historical Weather API (archive), 2016–2025, aggregated in code**, not the Climate API (model projections). One ~105-unit call per location per year, 12-row aggregate cached for 365 days. Alternative: 30-year normals (3× the units) or the Climate API (cheaper, less accurate).
- **[D2] Regions = anchor place + radius.** Open-Meteo geocoding returns no bounding boxes, and Nominatim is avoided (usage policy). The user picks a place (e.g. Marbella), switches to "region", sets a radius (default city 15 km, region 40 km) and may rename it ("Costa del Sol"). Display name and anchor place are stored separately.
- **[D3] Free-text fallback** when geocoding finds nothing: stores only the name and an optional country (so country facts still work). Weather, daylight, summary and places are "unavailable: no location" for free text.
- **[D4] Months are alternatives** ("March or April"), stored without a year; they always mean the next occurrence (15th of the month, on or after the current month). A trip for "December" viewed in January then refers to next December. *Confirmed by Alex 2026-10-28.*
- **[D5] Trip length 1–60 days.**
- **[D6] `wants_flights` defaults to true**; the form unchecks it when the profile has no home airports.
- **[D7] Extra `notes` field on trips** (not in the brief): trip-specific context like ship name or port list; optional, ≤ 2000 chars, for phase 3.
- **[D8] Cap of 30 trips per user** (server check), also bounds the shared demo account. *Confirmed by Alex 2026-10-28 (changed from 100).*
- **[D19] Retention 18 months** after the later of last update and trip end; nightly pg_cron purge. *Requested by Alex 2026-10-28.*
- **[D9] Country facts from a static dataset built from REST Countries** (like airports), instead of runtime calls: deterministic, no outages, no cache rows. Rebuilt about yearly by script; the UI shows the dataset date as the check date.
- **[D10] Plug types and voltage omitted in phase 2.** No machine-readable, public-domain, maintained source was found (IEC World Plugs and WorldStandards are copyrighted; Wikipedia is CC BY-SA and needs fragile parsing). The `plugs` field stays `null`. Backlog candidate: the US ITA "Electric Current Worldwide" table (US government work, public domain) after checking it is current.
- **[D11] Destination summary from Wikivoyage (user locale) via geosearch**; title match, else nearest article within 5 km, else none. Shown verbatim with attribution, never sent to the LLM.
- **[D12] `christmas_markets` uses the sparse OSM tag `xmas:feature=market` experimentally**; if the Passau/Wien fixture is empty it becomes "no source" (AI suggests without facts, flagged unverified). `nightlife`, `cruise`, `festivals_events` and custom interests have no deterministic source.
- **[D13] At most 4 interest queries per trip**; no purpose / no known interest → the `general` sightseeing set.
- **[D14] Facts are computed on view from `api_cache`, not stored per trip**, and streamed per panel with Suspense; caches are warmed after save with `after()`. Phase 3 snapshots `TripFacts` into `plan_versions`.
- **[D15] The geocode route requires login** (unlike `/api/airports`) because it proxies an external API.
- **[D16] `api_calls` stores no cache keys, query text or coordinates**, and `api_cache` has no grants at all (not even for admins).
- **[D17] Ages without travel dates are shown "today"**; with months, at the earliest next-occurrence date.
- **[D18] Trips become the first nav item** and `/app` links to the trip list.
