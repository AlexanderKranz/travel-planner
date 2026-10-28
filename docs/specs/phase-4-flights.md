# Phase 4 spec: verified direct flights

Status: proposed (architect, 2026-10-28; every call is listed as **[D#]** in section 11 for Alex to review).
Decisions and reasons: `docs/adr/0004-phase-4-flights.md`. Research basis: `docs/research/flight-data.md`. Conventions of the phase 1–3 specs apply unchanged.

Scope: AeroDataBox client with quota guard, `FlightsFact` (direct routes origin × gateway for the trip's dates or a sample week), flights panel on the trip page (separate route + client loader), deterministic max-flight-time filter, booking deep links, verified routes in the plan input and a code-filled `plan.flights` section.
Not in phase 4: prices, connecting flights, booking/items with status (phase 5), alerts on schedule changes, multi-city trips. **No migration** (`api_cache`, `api_calls.units/quota_remaining` and `CacheProvider "aerodatabox"` already exist).

---

## 1. What "verified direct flights" means

A **pair** = origin airport O × gateway airport G. A **leg** = one scheduled flight (number, local times) on a checked date.

| Input | Rule |
|---|---|
| `wantsFlights` | false → no panel, no calls, no `plan.flights` |
| Origins | `trip.originAirports` if non-empty, else `profile.homeAirports`; **first 2 only** **[D1]**. None → `unavailable: no_origin` |
| Gateways | `gatewayAirports(anchor)` from `src/lib/plan/airports.ts` (2 nearest within 150 km, unchanged). Freetext destination → `no_location`; none within 150 km → `ok` with `gateways: []` (UI: "no airport within 150 km") |
| Dates, `kind: date` | `outDate = startDate`, `backDate = startDate + lengthDays − 1`, `basis: "trip_dates"` |
| Dates, `kind: months` | **sample week** of the first selected month: `outDate` = first Saturday on/after the 8th, `backDate = outDate + lengthDays − 1`, `basis: "sample_week"` **[D2]** |
| Dates, `kind: none` | `unavailable: no_dates` (zero units; UI asks for a month) |

**Horizon.** `HORIZON_DAYS = 360` (API limit 365, margin). Per direction: date ≤ today + 360 → `mode: "schedule"`; else `mode: "proxy"` with `proxyDate(date, today)`: same month and day-of-month in the latest year Y such that the shifted date < today, then moved to the nearest same weekday (−3…+3 days, staying in that month if possible). Proxy results are labelled "flown in {month/year}, not yet published for {month/year}" and are **never** called "verified" **[D3]**.
Within the horizon there is no automatic proxy fallback (quota); "none" is phrased per section 2.2.

### 1.1 Lookups per trip (all through `cached()`, sequential, ≥ 1.1 s apart)

| Step | Endpoint (RapidAPI host `aerodatabox.p.rapidapi.com`) | Units | When |
|---|---|---|---|
| R | `GET /airports/iata/{O}/stats/routes/daily/{sampleDate}` | 6 | per origin; gives which G are served, operators, flights/day |
| F-out | `GET /flights/airports/iata/{O}/{d}T00:00/{d}T11:59` and `…/{d}T12:00/{d}T23:59`, query `direction=Departure&withLeg=true&withCancelled=false&withCodeshared=false&withCargo=false&withPrivate=false&withLocation=false` | 2 + 2 | `d = outDate` (or proxy), only if R lists at least one G for O |
| F-back | same at `{G}` on `backDate` | 2 + 2 | per G served from any origin |
| N | `GET /flights/number/{LH1148}/dates/{YYYY-MM-01}/{YYYY-MM-last}` | 2 | weekdays for the first outbound leg and the first return leg only (max 2 per trip) **[D4]** |

`sampleDate` (routes stats cover the 7 days *before* the date): the 15th of the outDate month; in March/October when `outDate ≥ last Sunday` (season change) use the last day of the month. Proxy mode applies the proxy shift before this rule.
Cold cost: 1 origin, 1 served gateway ≈ 6 + 4 + 4 + 4 = **18 units**; worst case (2 × 2) ≈ 32. A per-trip cap `TRIP_UNIT_CAP = 32` stops further fetches; unfetched pairs get `not_checked`. R with no G served → only 6 units.
Warm cache (same origin + month, same day at G): 0 units.

### 1.2 Cache keys and TTL (`cacheKey(endpoint, 1, params)`, provider `aerodatabox`)

| Endpoint id (`api_calls.endpoint`) | Params | Stored payload | TTL |
|---|---|---|---|
| `routes_daily` | `{ a: "FRA", d: sampleDate }` | `RouteStat[]` (normalized: `to`, `perDay`, `operators[{iata?,name}]`) | 7 d if `d` ≤ today + 30, else 14 d; past 90 d |
| `fids_departures` | `{ a, d, w: "am" \| "pm" }` | `FidsLeg[]` for **all** destinations of that airport/window (shared by every user) | future 7 d; past 90 d |
| `flight_dates` | `{ n: "LH1148", m: "2027-03" }` | `string[]` (ISO dates) | future 7 d; past 90 d |

Payloads are normalized (compact) before caching, never raw (FRA FIDS raw = 300 KB, normalized ≈ 40 KB).

### 1.3 Quota guard (`src/lib/server/flights-quota.ts`) **[D5]**

```ts
export type QuotaState = { usedToday: number; dailyCap: number; remaining: number | null; minRemaining: number };
export async function getQuotaState(): Promise<QuotaState>;  // admin client
export async function assertUnits(cost: number): Promise<void>; // throws QuotaGuardError (name "QuotaGuardError")
```
- `usedToday` = `sum(units)` from `api_calls` where `provider='aerodatabox'` since Europe/Berlin midnight (index `api_calls_provider_idx`). Includes failed calls (see below).
- `remaining` = `quota_remaining` of the newest `aerodatabox` row with a non-null value (from header `x-ratelimit-api-units-remaining`), null if never seen.
- Refuse when `usedToday + cost > AERODATABOX_DAILY_UNITS` (default 40) or `remaining !== null && remaining − cost < AERODATABOX_MIN_REMAINING` (default 40).
- `assertUnits` is called **inside the fetcher** so a cache hit never checks and a refusal serves stale data if any.
- `cached()` changes (small, integrations-dev): `CachedResult` error union gains `"quota_exhausted"`; `classifyError` maps `QuotaGuardError` → code `quota_guard`; for thrown errors carrying `units`/`quotaRemaining` (AeroDataBox `HttpError` subclass), log them, because **failed requests cost units** (400s cost 2). Never retry.
- Client-side validation before any call: date within [today − 365, today + 365], window ≤ 12 h, IATA `^[A-Z]{3}$`, flight number `^[A-Z0-9]{2}\d{1,4}[A-Z]?$`.
- Missing `AERODATABOX_API_KEY` → `unavailable: disabled`, zero calls.
- Rate: module-level promise chain, min 1 100 ms between requests (1 req/s plan limit).

---

## 2. Data

### 2.1 Domain types (`src/lib/domain/flights.ts`, step 0)

```ts
export const IataCode = z.string().regex(/^[A-Z]{3}$/);
export type FlightDir = "out" | "back";
export type FlightMode = "schedule" | "proxy";

export type FlightLeg = {
  dir: FlightDir; from: string; to: string;
  number: string;                 // display form "LH 1148"
  airline: string | null;         // resolved name; null = unknown (show number only)
  operatedBy?: string;            // only when the API marks a different operator
  dep: string; arr: string;       // local HH:MM at from/to
  arrDayOffset: 0 | 1;
  blockMin: number;               // from scheduled UTC times
  date: string;                   // schedule date actually checked (proxy date in proxy mode)
  weekdays?: number[];            // 1=Mo..7=Su, from step N
  operatingDays?: { days: number; of: number; month: string };  // "25 of 31 days in 2027-03"
  tooLong?: true;                 // blockMin > maxBlockMin
};
export type PairStatus = "found" | "none" | "not_published" | "not_checked";
export type FlightPair = {
  from: string; to: string; toName: string; gatewayKm: number;
  status: PairStatus;
  perDay?: number;                                   // routes/daily average (1 decimal)
  operators: { iata?: string; name: string }[];      // from routes/daily; private/unnamed filtered
  approxBlockMin: number;                            // great-circle estimate, always present
};
export type FlightsFacts = {
  basis: "trip_dates" | "sample_week";
  outDate: string; backDate: string;
  mode: { out: FlightMode; back: FlightMode };
  checkedDates: { out: string; back: string };       // after proxy shift
  origins: string[]; gateways: { iata: string; name: string; km: number }[];
  pairs: FlightPair[];                               // sorted: found first, then by gatewayKm
  legs: FlightLeg[];                                 // max 6 per direction, sorted: fitting first, then dep time
  maxBlockMin: number | null;                        // from the purpose (section 4)
  quotaLimited: boolean;                             // at least one lookup refused by the guard
};
```
`facts.ts`: `SourceId` gains `"aerodatabox"`; unavailable `reason` gains `"no_origin" | "no_dates" | "disabled"`; `TripFacts` gains `flights?: Fact<FlightsFacts>` (optional: only the plan pipeline fills it). Fact `fetchedAt` = oldest lookup `fetchedAt`; `stale` = any lookup stale.

### 2.2 Rules (pure, `src/lib/flights/build.ts`)
- Leg kept only if: arrival IATA = the pair's other end, number present and valid, not private/cargo, dep/arr times present. Codeshare duplicates: same `from/to/dep` → keep the entry whose number prefix equals the operator, else the first.
- `airline` = `AIRLINES[prefix]?.name` ?? (API `airline.iata === prefix` ? API name : null). Never shows "Flight Alaska" for `4Y`.
- `blockMin` = `(arrUtc − depUtc)` in minutes; `approxBlockMin = round5(30 + km / 13.3)` (≈ 800 km/h + 30 min), labelled "approx." **[D6]**.
- Pair status: legs found → `found`; R says not served or F has no leg, and checked date ≤ today + 180 → `none`; > today + 180 (schedule) or proxy → `not_published`; lookup refused/failed without stale data → `not_checked`.
- Weekdays from step N dates of the month (`operatingDays`); without N: omitted.
- UI wording per state: found (schedule) "Direct, in the published schedule for {date}"; found (proxy) "Flown on {date} last year, not yet published for {month}; check before booking"; none "No direct flight found in the schedule"; not_published "Schedule not yet published"; not_checked "Not checked (limit reached), try again tomorrow". Always "Times and routes can change."

### 2.3 Deep links (pure, `src/lib/flights/links.ts`, no prices) **[D7]**
```ts
export function flightLinks(a: { from: string; to: string; out: string; back: string; adults: number; locale: "de"|"en";
  airlineIata?: string }): { google: string; skyscanner: string; airline?: string };
```
- Google Flights: `https://www.google.com/travel/flights?hl={locale}&q=` + encoded `Flights from {FROM} to {TO} on {out} through {back} nonstop`.
- Skyscanner: `https://www.skyscanner.{de|net}/transport/flights/{from}/{to}/{yymmdd}/{yymmdd}/?adultsv2={adults}&stops=!oneStop,!twoPlusStops` (lowercase IATA). `adults` = `max(1, group.adults + group.unknown)` or 1 without a group; children are not passed.
- Airline: homepage from `AIRLINES` table only (no search parameters).
- Built for the real trip dates (sample week dates in months mode, never proxy dates). Links are computed in the UI from the fact, never stored.

`src/lib/flights/airlines.ts`: `AIRLINES: Record<string, { name: string; url: string }>` for at least LH, OS, LX, EW, 4Y, DE, FR, U2, VY, IB, UX, TP, AF, KL, BA, TK, A3, SN, DY, W6, X3, HV (integrations-dev; homepages only).

---

## 3. Server and route

```ts
// src/lib/integrations/aerodatabox.ts (server-only; reads AERODATABOX_API_KEY)
export function fetchRoutesDaily(a: string, date: string): Promise<FetchOutcome<RouteStat[]>>;
export function fetchDepartures(a: string, date: string, w: "am" | "pm"): Promise<FetchOutcome<FidsLeg[]>>;
export function fetchFlightDates(number: string, month: string): Promise<FetchOutcome<string[]>>;
// raw Zod schemas (loose) + normalizers in src/lib/integrations/aerodatabox-normalize.ts (pure, fixture-tested)
export type FidsLeg = { number: string; airlineIata?: string; airlineName?: string; operatorIata?: string;
  to: string; depLocal: string; depUtc: string; arrLocal?: string; arrUtc?: string };   // local "YYYY-MM-DD HH:MM"
export type RouteStat = { to: string; perDay: number; operators: { iata?: string; name: string }[] };

// src/lib/server/facts/flights.ts
export function getFlightsFacts(trip: Trip, a: { homeAirports: string[]; purpose: TripPurpose | null;
  ctx: FactsCtx; budgetMs?: number }): Promise<Fact<FlightsFacts>>;   // never throws
```
`FetchOutcome.units` = known tier cost (6/2/2); `quotaRemaining` from the response header. `budgetMs` (default 25 000 in the route, 20 000 in the plan pipeline): lookups not started in time → `not_checked`.

Route `src/app/api/trips/[id]/flights/route.ts`: `GET ?locale=` → `Fact<FlightsFacts>`, pattern of `places/route.ts` (session 401, `rateLimit("flights:"+userId, 6, 60_000)` → 429, RLS `getTrip` 404, `getProfile()` for home airports, `no-store`). `maxDuration = 60`.

Plan pipeline (`generatePlan`): if `trip.wantsFlights`, `getTripFacts(…, { placesBudgetMs: 30_000, withFlights: { homeAirports } })` also runs `getFlightsFacts` with `budgetMs: 20_000` (usually a cache hit because the panel loaded first). Not in `warmTripFacts` (no units for trips nobody opens) **[D8]**.

---

## 4. Max flight time (deterministic) **[D9]**

`src/lib/flights/constraint.ts`:
```ts
export function maxBlockMinutes(p: TripPurpose | null): number | null;
```
1. `p.guided.maxFlightHours` (new optional field in `PurposeGuided`: `z.number().min(1).max(15).multipleOf(0.5).optional()`, form select "any, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12 h"; jsonb, no migration).
2. Else regex over `constraints` and `text` (case-insensitive, first match): `max(?:imal|\.)?|höchstens|bis zu|up to|at most|under|unter` + number (`,`/`.` decimal) + `h|std\.?|stunden|hours?` within 25 chars of `flug|flight|fly|flugzeit`. "max 3 h flight from FRA" → 180.
3. Else null. Hours × 60. No LLM.

Effect: legs with `blockMin > max` get `tooLong`; pairs without fitting legs show a "longer than your {h} h limit" badge (using `blockMin`, else `approxBlockMin` marked approx.). Too-long legs stay visible (greyed, sorted last) but are **not** sent to the plan input.

---

## 5. Plan integration (backend-dev)

### 5.1 Input (`PlanInput`, `src/lib/plan/input.ts`)
```ts
flights?: { mode: "schedule" | "proxy";
  out:  { f: string; t: string; dep: string; arr: string }[];   // fitting legs, max 3, by dep time
  back: { f: string; t: string; dep: string; arr: string }[] };
```
- Only when `facts.flights` is `ok` with at least one fitting leg; no numbers, no airline, no dates (`dayList` already has them) → model cannot leak flight numbers.
- `airports` (gateways) is reordered: gateways with a found pair first; only those when any exist (replaces the phase 3 heuristic for `ap`) **[D10]**.
- `PLAN_PROMPT_VERSION = "plan-2"` (changes all hashes once; existing plans just regenerate when asked). The hash includes `flights` naturally; schedule refreshes that change times change the hash.

### 5.2 Prompt rule 8 (replace)
"8. With `flights`: day 1 starts after arrival: first activity at least 90 min after the earliest `out.arr`; on the last day the last activity ends at least 150 min before the latest `back.dep`. You may add one `travel` activity with `at` = the given time (text without numbers or airline, e.g. 'Arrival and transfer'). Without `flights` but with `airports`: on day 1 and the last day prefer places with small `ap`. Never state flight numbers or airlines." Rule 4 unchanged.

### 5.3 `plan.flights` (filled by code in `assemblePlan`, never by the LLM)
`src/lib/domain/plan.ts`: replace `flights: z.unknown().optional()` with `PlanFlights.optional()`:
```ts
export const PlanFlightLeg = z.object({ dir: z.enum(["out","back"]), from: IataCode, to: IataCode,
  number: z.string().max(10), airline: z.string().max(60).nullable(), dep: HHMM, arr: HHMM,
  arrDayOffset: z.union([z.literal(0), z.literal(1)]), blockMin: z.number().int().min(0).max(1440),
  date: IsoDate, weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(), tooLong: z.literal(true).optional() });
export const PlanFlights = z.object({
  basis: z.enum(["trip_dates","sample_week"]), outDate: IsoDate, backDate: IsoDate,
  mode: z.object({ out: z.enum(["schedule","proxy"]), back: z.enum(["schedule","proxy"]) }),
  pairs: z.array(z.object({ from: IataCode, to: IataCode, status: z.enum(["found","none","not_published","not_checked"]),
    perDay: z.number().optional() })).max(4),
  legs: z.array(PlanFlightLeg).max(12), maxBlockMin: z.number().int().nullable(),
  source: z.literal("aerodatabox"), fetchedAt: z.string() });
```
`buildPlanInput` returns `flights: PlanFlights | undefined` (mapped from the fact, all legs incl. `tooLong`); `assemblePlan` sets it. Patches/edits/restores copy it verbatim (phase 3 rule). Absent when `wantsFlights` is false or the fact is unavailable.

### 5.4 Evals
- `evals/build-input.ts`: golf gets a recorded `Fact<FlightsFacts>` built by the pure builder from the aerodatabox fixtures (outbound `fids-departures-FRA-2026-03-07-past.json` as proxy for 2038-03-13, return from a new `fids-departures-AGP-2026-03-11-past.json`, section 9); cruise has `flights: false`.
- Checks: plan has `flights` iff the fixture wants flights; golf: an `out` FRA→AGP leg with `blockMin ≤ 180` and not `tooLong`; mode `proxy`; day 1 first `at` ≥ earliest out `arr` + 90 min; no flight-number regex hits in any `text` (existing check, now scoped to LLM text, not `plan.flights`).
- Re-record golf generate once (≤ $0.15) after the prompt change; cruise recordings only get a hash warning.

---

## 6. UI (frontend-dev)

- `src/components/facts/flights-loader.tsx` (client, pattern of `places-loader.tsx`): fetches `/api/trips/{id}/flights?locale=`, skeleton, retry button on error/429.
- `src/components/facts/flights-panel.tsx` (presentational, takes `Fact<FlightsFacts>` + `adults`): header "Direct flights" + basis line ("for your dates {out} – {back}" / "sample week in {month}"); per pair a card: `FRA → AGP` (gateway name, "{km} km to destination"), status badge (verified = solid, proxy = light outline, none/not_published/not_checked = muted), operators + "≈ {perDay} per day"; legs per direction as rows: number · airline · dep → arr (+1) · "{h} h {mm}" · weekday chips (Mo–Su, active ones filled) · "{days} of {of} days"; `tooLong` rows greyed with "over your {h} h limit". Below: deep-link buttons (Google Flights, Skyscanner, airline) `target=_blank rel="noopener noreferrer"`, "Times and routes can change", `SourceNote` (AeroDataBox, checked {date}, stale).
- Unavailable states: `no_origin` (link to settings and trip edit), `no_location`, `no_dates` (link to trip edit), `disabled`, `provider_error`; `quotaLimited` → info line.
- Trip page: new grid row after Summary/Glance, before Places (`order-3 lg:col-span-2`, places becomes `order-4`); only when `trip.wantsFlights`.
- `src/components/plan/plan-flights.tsx`: compact strip in the plan view from `plan.flights` (fitting legs only, mode label, source + date; used later by share/PDF). Insert in `plan-facts-strip.tsx` or below the header.
- Purpose form: `maxFlightHours` select (section 4) in the guided block.
- Sources page: AeroDataBox entry (`SOURCES` in `src/lib/facts/sources.ts`): homepage `https://aerodatabox.com`, "Flight schedules via RapidAPI, Basic plan (non-commercial use, attribution required)".
- 360 px: rows wrap (`flex-wrap`), times never truncated, weekday chips `text-xs`, buttons full width below `sm`, touch targets `min-h-11`.

i18n (`messages/de.json` + `en.json`, same keys): `facts.flights.{title, basisDates, basisSample, gatewayKm, perDay, operators, approx, duration, nextDay, weekdays.{1..7}, operatingDays, tooLong, change, links.{google,skyscanner,airline}, status.{found,foundProxy,none,notPublished,notChecked}, unavailable.{no_origin,no_location,no_dates,disabled,provider_error}, quotaLimited, noGateway, retry}`, `plan.flights.{title, proxyNote}`, `purposes.guided.maxFlightHours.{label, any, hours}`, `sources.aerodatabox.{name, note}`.

---

## 7. Environment and secrets

| Env (server-only) | Default | Note |
|---|---|---|
| `AERODATABOX_API_KEY` | unset = feature off | RapidAPI key; present in `.env.local`. **Alex: add to Vercel Production + Preview.** |
| `AERODATABOX_DAILY_UNITS` | 40 | per Berlin day, all users |
| `AERODATABOX_MIN_REMAINING` | 40 | monthly safety margin |

Add all three to `.env.example` (backend-dev). Never `NEXT_PUBLIC_`.

**Tonight's live budget: max 50 units total** (Alex approved). Set `AERODATABOX_DAILY_UNITS=50` locally; before each live call the developer checks `sum(units)` in `api_calls` (or the header). Planned use: AGP return fixture (4) + 2 flight-dates fixtures if needed (≤ 4) + one app smoke test of the golf trip with real 2027 dates (≤ 18) + one months-mode trip (≤ 18) = ≤ 44. Unit tests and evals use fixtures only (mock `fetch`).

---

## 8. Tests

- `aerodatabox-normalize.test.ts`: fixtures → `FidsLeg[]` (LH 1148 09:20→12:20; "Flight Alaska" `4Y` kept with prefix; no-IATA arrivals dropped), `RouteStat[]` (AGP 1.71/day, unnamed operator handled), errors fixture.
- `aerodatabox.test.ts` (mocked fetch): headers sent, units + `quotaRemaining` from headers, 400 → error carrying units, date validation rejects > 365 d without calling.
- `flights-quota.test.ts`: daily cap, min remaining, Berlin midnight, null remaining.
- `api-cache.test.ts`: quota guard → `quota_exhausted` + stale served; failed call logs units.
- `src/lib/flights/*.test.ts`: lookups (dates per timing, sample week, horizon, `proxyDate` keeps weekday incl. 2038-03-13 → Sat 2026-03-14, season-change sample date), build (statuses, dedupe, block time across time zones and midnight, sort), constraint (de/en phrases, guided wins, null), links (exact URLs).
- `server/facts/flights.test.ts` (mocked clients): R without gateway → no FIDS calls; trip unit cap; budgetMs; disabled; no_origin.
- Plan: `input.test.ts` (flights compact, no numbers, gateway reorder, absent when unwanted), `assemble.test.ts` (`plan.flights` set by code, survives patch), `plan.test.ts` (schema).
- Route: 401, 404, 429.

---

## 9. Implementation split

**Step 0 — contract (backend-dev, ≤ 30 min; others start from it):**
`src/lib/domain/flights.ts` (2.1), `facts.ts` additions, `PlanFlights` in `plan.ts`, `PurposeGuided.maxFlightHours`, exports in `domain/index.ts`; fixtures `src/lib/flights/__fixtures__/flights-fact-{found,proxy,mixed}.json` (`Fact<FlightsFacts>`) + `flights-fact-unavailable.json` (array of states); stubs `getFlightsFacts` (returns the found fixture) and the route; typed stubs `src/lib/flights/{lookups,build,constraint,links,airlines}.ts`.

| Agent | Owns (writes) | Depends on |
|---|---|---|
| **integrations-dev** | `src/lib/integrations/aerodatabox{,-normalize}.ts` + tests; `src/lib/server/flights-quota.ts`; `src/lib/server/api-cache.ts` change (1.3); `src/lib/server/facts/flights.ts`; `src/lib/flights/{lookups,build,airlines,links}.ts` + tests; `src/lib/facts/sources.ts` entry; new fixture `fids-departures-AGP-2026-03-11-past.json` (+ `flight-dates-*` only if needed); live calls within the 50-unit budget | step 0 |
| **backend-dev** | step 0; `src/lib/flights/constraint.ts` + test; `src/app/api/trips/[id]/flights/route.ts`; `src/lib/server/facts/index.ts` (`withFlights`); `src/lib/plan/{input,assemble,prompt}.ts`, `src/lib/domain/ai.ts` (`plan-2`); `src/lib/server/plan-pipeline.ts` wiring (profile home airports); `evals/**` updates + one golf re-record; `.env.example` | step 0; `getFlightsFacts` stub until integrations lands |
| **frontend-dev** | `src/components/facts/flights-{loader,panel}.tsx`; `src/components/plan/plan-flights.tsx`; `src/app/[locale]/app/trips/[id]/page.tsx` (+ `_panels/`); purpose form field; `src/app/[locale]/sources/page.tsx` if needed; `messages/{de,en}.json` keys of section 6 | step-0 fixtures |

Order: step 0 → parallel → integrations merges client + builder → backend swaps the stub, wires plan → frontend against the real route → live smoke (golf with real 2027 dates, 360 px). `npm test`, `lint`, `typecheck` before each report. Contract changes after step 0 go through the architect.

---

## 10. Risks
- Far-future schedules are incomplete: absence is phrased as "not yet published" beyond 180 days; proxies are labelled.
- Quota is small (400/month): lazy fetch, shared normalized caches, daily cap, min-remaining guard; Pro plan ($8/month) as an escape hatch (Alex's call).
- Deep-link URL formats are unofficial and can change; they carry no data we rely on.
- Sample week in months mode may hit a holiday week; label says "sample week".

## 11. Decisions (please review)
- **[D1]** At most 2 origins (trip airports, else profile) × 2 gateways (phase 3 nearest-within-150 km logic) per trip.
- **[D2]** Months mode checks one **sample week** (first Saturday on/after the 8th of the first selected month, plus trip length); undated trips get no flight lookup.
- **[D3]** Beyond 360 days, "past as proxy": same weekday near the same date in the latest past year, labelled as flown last year, never "verified". No automatic proxy within the horizon.
- **[D4]** Weekday patterns are fetched for at most 2 flight numbers per trip (first outbound and first return leg).
- **[D5]** Quota guard: daily cap 40 units (Berlin day), refuse below 40 remaining in the month; refusals show "not checked", stale cache is served when present; failed calls count.
- **[D6]** Block time from scheduled UTC times; without a leg an approximate great-circle estimate (30 min + 800 km/h), labelled "approx.".
- **[D7]** No prices; Google Flights, Skyscanner (nonstop filter) and airline-homepage links built deterministically from IATA codes, dates and adult count.
- **[D8]** Flights load lazily (panel view or plan generation), not in the facts warm-up after trip save.
- **[D9]** Max flight time comes from a new optional purpose field `maxFlightHours`, else a de/en regex over constraints/text; too-long legs stay visible but are excluded from the plan input.
- **[D10]** The plan input gets fitting legs as times only (no numbers, airlines); gateways with a verified route replace the heuristic `ap` airport; `plan.flights` is a code snapshot; prompt version `plan-2`.
