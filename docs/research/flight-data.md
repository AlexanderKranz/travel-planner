# Flight data spike: AeroDataBox (RapidAPI Basic)

Date of research: 2026-10-27. Docs checked: https://doc.aerodatabox.com (OpenAPI spec `openapi-rapidapi-v1.json`), https://aerodatabox.com/pricing. Live test calls: 13 (of 25 allowed), 50 API units spent (400 units/month on Basic; 350 left).

## Verdict: GO (with conditions)

AeroDataBox can tell us which direct flights leave a home airport in a given month, with airline and flight number, and it covers schedules up to 365 days ahead. The free quota is enough for a ~20-user private app only if every response is cached and shared across users. Conditions: see "Risks".

## Question and evidence

| Test | Result |
|---|---|
| 1. FRA to AGP in March | Found. Future (Sat 2027-03-06): `LH 1148` 09:20 FRA to 12:20 AGP, A320, Lufthansa. Past (Sat 2026-03-07): `LH 1148` 08:35 and `LH 1150` 13:00. `routes/daily` FRA 2027-03-14 week: AGP 1.71 flights/day, operators LH plus one with no IATA code. `flights/number/LH1148/dates` for March 2027 returns 25 of 31 days (it is not only Saturday/Wednesday, so that assumption was outdated). |
| 2. FRA to unserved airport | LMP (Lampedusa) and HOQ (Hof) absent from all FRA route lists and from both FIDS dumps. Only airports present in schedule data can be listed, so absence is the default. |
| 3. Coverage outside FRA | MUC: 166 destinations, AGP 1.43/day (LH). VIE: 137 destinations, AGP 2.14/day (OS, FR). LNZ (Linz): 3 routes (FRA 2.71/day by DX, ALC, HRG at 0.29/day, i.e. charter-like). Small home airports are covered but thin, which looks realistic. |

## Endpoints evaluated

| Endpoint | Tier / cost | Use |
|---|---|---|
| `GET /airports/iata/{A}/stats/routes/daily/{date}` | Tier 3 = 6 units | Destinations from airport A, `averageDailyFlights` and operators (airline name/IATA/ICAO), **no flight numbers**. Statistics over the **7 days before** `date`. Works for future dates too (tested 2027-03-14: 222 destinations). Response 50-90 KB, 1 request. Best for "which destinations can I fly direct to, and with whom". |
| `GET /flights/airports/iata/{A}/{from}/{to}?direction=Departure&withLeg=true&...` (FIDS) | Tier 2 = 2 units | Actual departures with `number`, airline, times, destination (needs `withLeg=true`). **Window max 12 h** (400 above). **Max 365 days ahead** (400 beyond). 12 h window at FRA = 330-380 flights, 185-330 KB. Cannot filter by destination, so one response serves all users of that origin and day. |
| `GET /flights/number/{LH1148}/dates/{from}/{to}` | Tier 2 = 2 units | Days in a range on which a known flight number operates. Good to verify and to fill the "operates on N days of the month" label. Only works once we know the number (from FIDS). |
| `GET /flights/number/{n}/{from}/{to}` | Tier 3 | Not needed. |
| `GET /airports/.../delays`, search, etc. | n/a | Not needed. |

Failed requests (HTTP 400) still cost units (2 each observed). Validate dates client-side before calling.
Response headers expose quota: `x-ratelimit-api-units-remaining`, `x-ratelimit-api-units-limit` (400), `x-ratelimit-requests-remaining` (also a 1,600 requests/month cap), `x-ratelimit-api-units-reset` (seconds to reset). The client should read and store them.

## Call log (13 calls, 50 units; cost verified by header deltas)

| # | Endpoint | Params | Status | Units |
|---|---|---|---|---|
| 1 | routes/daily | FRA (no date, today) | 200 | 6 |
| 2 | routes/daily | FRA 2026-03-14 | 200 | 6 |
| 3 | routes/daily | FRA 2027-03-14 | 200 | 6 |
| 4 | FIDS | FRA 2027-03-06 06:00-18:00 Dep, withLeg | 200 | 2 |
| 5 | FIDS | FRA 2027-03-06 00:00-23:59 (24 h) | 400 window >12 h | 2 |
| 6 | FIDS | FRA 2027-10-16 08:00-10:00 | 200 (50 flights) | 2 |
| 7 | flights/number dates | LH1148 2027-03 | 200 | 2 |
| 8 | FIDS | FRA 2028-03-04 (>365 d) | 400 | 2 |
| 9 | FIDS | FRA 2026-03-07 06:00-18:00 | 200 | 2 |
| 10-12 | routes/daily | MUC, VIE, LNZ 2027-03-14 | 200 | 6 each (18) |
| 13 | flights/number dates | LH1150 2027-03 | 200 | 2 |

## Future coverage and the "past as proxy" question

- Future schedules exist up to 365 days ahead and are real schedule data (`quality: ["Basic"]`, no live data), not placeholders: LH 1148 appears for March 2027 and flights exist for 2027-10-16.
- Future data is **less complete** than past data. Same Saturday, 12 h window at FRA: 2026-03-07 had 383 departures (169 destinations, all `IsOperator`, `quality Basic+Live`); 2027-03-06 had 329 (161 destinations, `codeshareStatus` mostly `Unknown`). LH 1150 (13:00) was on the 2026 Saturday but not on 2027-03-06 (the dates endpoint shows it flying Tuesdays and the last days of March 2027, so that is a real timetable change, not necessarily a gap). Airlines publish schedules in tranches, so far-future months can be missing routes (summer charters, late airline filings).
- Conclusion: do not treat absence in far-future data as proof of "no flight". Only presence is proof. Use the same month of the past year as a **second, labelled source** for "operated last year" when the future data is thin, never as a promise.
- The routes/daily week-based average also means routes flown less than weekly can be missed in a single-week sample. Sample up to 4 weeks (end dates 7, 14, 21, 28 of the month) only when the user opens a specific destination.

## Recommended lookup strategy

1. **Destination discovery** (home airport A, month M): `routes/daily` with `dateLocal` = mid-month date (e.g. the 15th), union with a second call for the 22nd/28th only if we want more recall. 6 units each. Cache key `aerodatabox:routes:{A}:{YYYY-MM}:{sampleDate}`. Gives destination, airline, flights/day.
2. **Flight numbers for a chosen destination** (only when a trip is being planned, since FIDS cannot filter by destination): FIDS for A on one representative day per weekday of interest, as 12 h windows (06:00-18:00 and 18:00-06:00 next day = 4 units/day, 24 h). Filter to arrival IATA = destination in code. Cache key `aerodatabox:fids:{A}:{date}:{window}` and keep the whole raw (compressed) day so any destination reuses it. Optionally verify each found number with `flights/number/.../dates` over the month (2 units each, 1-3 numbers) to display "operates on 25 of 31 days in March".
3. Do not call anything per user request in real time except on a cache miss, and cap per-day spend with a counter (see cost).
4. TTL: routes 7 days (month >30 days away: 14 days), FIDS future days 7 days, past/proxy data 90 days (immutable). Store the `checkedAt` date with the entry.

Calls per new trip with a cold cache: 1 routes (6) + 2 FIDS windows (4) + 1-2 dates checks (2-4) = about 12-14 units. Warm cache for the same airport and month: 0.

## Quota math (Basic: 400 units and 1,600 requests / month, 1 req/s)

- Per cold trip about 14 units, so about 28 cold trips/month. 20 users x 3 trips = 60 trips/month, but home airports are few (FRA, MUC, VIE, LNZ...) and months overlap, so realistic distinct (airport, month) pairs are about 10-20 -> 140-280 units. That fits, with thin margin. Preload nothing, be lazy.
- Safety margin: budget guard in the client (refuse when `remaining` < 40 and show cached/"unavailable" instead). Never retry 400s.
- Headroom option: Pro plan is $8/month for 5,000 units (RapidAPI, 2 req/s). Likely not needed at 20 users.
- Terms: Basic plan says commercial use not allowed and attribution to AeroDataBox is required. A private friends-and-family app is fine, but we must show "Data: AeroDataBox" (the UI source label does this) and move to a paid plan if the app ever becomes commercial.

## Data-quality caveats

- Airline field can be wrong or missing for future flights: `4Y 502` (Eurowings Discover) is named "Flight Alaska" without IATA code (19 of 329 future FRA flights have no airline IATA; 2 of 383 in the past data). Resolve the airline from the flight-number prefix with a small IATA table, fall back to the API name, and never show an airline we cannot name.
- `codeshareStatus` is `Unknown` for most future FRA flights, so with `withCodeshared=false` the API applies heuristic filtering. Codeshare duplicates (a LH-numbered flight operated by another carrier) may remain. Show "operated by" only when known.
- Operators with no `iata` in routes/daily (AGP lists one) and private/charter operators (e.g. VistaJet) can appear: filter private (`withPrivate=false` for FIDS) and require a flight number for any "verified" label.
- Some arrivals lack an airport IATA (1-2 per day dump): skip them.
- Times are schedule times in local time with UTC; they change. Future entries have no live status.
- routes/daily mixes seasons if the sampled week spans a schedule change (end of March IATA summer season starts the last Sunday of March): for March use a date before the 25th for winter-season, after the 31st for summer-season, and prefer FIDS on the actual travel week.
- Duration/aircraft come with FIDS but we do not need them.

## UI labelling (i18n keys to add later, de + en)

Show source and check date on every flight fact (ground rule 1):
- Verified in schedule: "Direkt: Lufthansa LH 1148, FRA 09:20 - AGP 12:20, plan data for 2027-03-06 (AeroDataBox, checked 2026-10-27)". Operates "an 25 von 31 Tagen" when known.
- Proxy from past: "Im selben Monat des Vorjahres geflogen (Lufthansa LH 1148, Fahrplan 03/2026). Fuer 03/2027 noch nicht veroeffentlicht, bitte vor Buchung pruefen." Visually distinct (lighter badge) and never counted as "verified".
- No data: "Keine Direktverbindung im Fahrplan gefunden" is only claimed for months with future coverage; otherwise "Fahrplan noch nicht verfuegbar".
- Always include "Zeiten und Verbindungen koennen sich aendern".

## Risks and open items

- The free plan is non-commercial and small. Mitigate with caching, quota guard, and fallback.
- Future completeness varies by airline; labelling above makes it honest.
- Not tested (budget-driven): Mar 2026 vs Mar 2027 destination diff across all of FRA, routes/daily accuracy for small airports (LNZ 3 routes plausible), behaviour above 1 req/s (client must serialize).

## Fallbacks if no-go later

Research only, no sign-ups:
- AeroDataBox direct (aerodatabox.com) free tier via ADS-B contribution, or paid Starter $19 / 40k units.
- OpenSky Network (free, but past tracks only, no schedules): usable only as a "flown last year" proxy; poor ergonomics.
- Airport websites / Eurocontrol-style public timetables: not machine-friendly.
- Aviationstack, AirLabs: free tiers exist but small (~100-1000 req/month) and schedule depth unverified; AirLabs has a routes endpoint (IATA-published routes) worth a spike if AeroDataBox quota is not enough.
- OurAirports/OpenFlights route data: static and years old, would violate "only routes proven by schedule data", so use only as hints, never as shown facts.

## Fixtures

`src/lib/integrations/__fixtures__/aerodatabox/`: `routes-daily-FRA-2027-03-14.json`, `fids-departures-FRA-2027-03-06.json` (future, with LH 1148 and the "Flight Alaska" anomaly), `fids-departures-FRA-2026-03-07-past.json`, `flight-dates-LH1148-2027-03.json`, `errors.json` (12 h and 365 day limits). Trimmed, no secrets or headers.
