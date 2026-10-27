# Data

## airports.json
Airports with scheduled service and an IATA code, for home-airport autocomplete.
Tuples: `[iata, name, city, countryIso2, lat, lon]`.

- Source: OurAirports, https://davidmegginson.github.io/ourairports-data/airports.csv (see https://ourairports.com/data/)
- Licence: public domain (no attribution required; no guarantee of accuracy)
- Fetched: see `fetchedAt` in the file
- Rebuild: `npm run airports:build` (about once a year)
