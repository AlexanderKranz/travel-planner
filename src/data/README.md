# Data

## airports.json
Airports with scheduled service and an IATA code, for home-airport autocomplete.
Tuples: `[iata, name, city, countryIso2, lat, lon]`.

- Source: OurAirports, https://davidmegginson.github.io/ourairports-data/airports.csv (see https://ourairports.com/data/)
- Licence: public domain (no attribution required; no guarantee of accuracy)
- Fetched: see `fetchedAt` in the file
- Rebuild: `npm run airports:build` (about once a year)

## countries.json
Country facts for the trip detail page: `{ source, fetchedAt, countries: { [cca2]: { nameEn, capital[], currencies[], languages[{code,nameEn}], callingCodes[], drivingSide } } }`.

- Source: mledoze/countries, https://github.com/mledoze/countries (the open data behind REST Countries v3). REST Countries itself is not used because v3.1 is deprecated and v5 needs an API key.
- Licence: Open Database License (ODbL 1.0), https://opendatacommons.org/licenses/odbl/1.0/. Attribution: "Country data: mledoze/countries (ODbL), via REST Countries lineage". Show it on the sources page.
- `drivingSide` is not in the source. It comes from a hand-maintained left-hand-traffic list in `scripts/countries/build.mjs` (Wikipedia, "Left- and right-hand traffic"); re-check it on every rebuild.
- Time zones are not in the dataset: the UI uses the destination's IANA zone from geocoding.
- Fetched: see `fetchedAt`. Rebuild: `npm run countries:build` (about once a year).
