// Builds src/data/countries.json from mledoze/countries (the open dataset behind REST Countries v3), ODbL 1.0.
// Source: https://github.com/mledoze/countries (countries.json), checked 2026-10-28.
// Why not REST Countries directly: since 2026 the v3.1 endpoint answers "This API version has been deprecated"
// and v5 requires an API key (https://restcountries.com/docs/countries/legacy-api-deprecation).
// Run: npm run countries:build   (about once a year)
// Output: { source, fetchedAt, countries: { [cca2]: { nameEn, capital[], currencies[{code,symbol?}],
//           languages[{code,nameEn}], callingCodes[], drivingSide } } }
// Driving side is NOT in the source: LEFT_HAND below is maintained by hand from
// https://en.wikipedia.org/wiki/Left-_and_right-hand_traffic (everything else is "right"). Re-check on rebuild.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_JSON = 'https://raw.githubusercontent.com/mledoze/countries/master/countries.json';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/data/countries.json');

const LEFT_HAND = new Set(
  ('AG AI AU BB BD BM BN BS BT BW CC CK CX CY DM FJ FK GB GD GG GI GS GY HK IE IM IN ID IO JE JM JP KE KI KN KY LC LK LS ' +
    'MO MS MT MU MV MW MY MZ NA NF NP NR NU NZ PG PK PN SB SC SG SH SR SZ TC TH TK TL TO TT TV TZ UG VC VG VI WS ZA ZM ZW').split(' '),
);

export function callingCodes(idd) {
  const root = idd?.root;
  const suffixes = idd?.suffixes ?? [];
  if (!root) return [];
  if (suffixes.length === 0) return [root];
  if (suffixes.length === 1) return [root + suffixes[0]];
  // +1 (NANP) and +7 have hundreds of area suffixes: the root is the calling code.
  if (root === '+1' || root === '+7') return [root];
  return suffixes.slice(0, 3).map((s) => root + s);
}

export function convert(list) {
  const countries = {};
  for (const c of list) {
    if (!/^[A-Z]{2}$/.test(c.cca2 ?? '')) continue;
    countries[c.cca2] = {
      nameEn: c.name.common,
      capital: c.capital ?? [],
      currencies: Object.entries(c.currencies ?? {}).map(([code, v]) => (v?.symbol ? { code, symbol: v.symbol } : { code })),
      languages: Object.entries(c.languages ?? {}).map(([code, nameEn]) => ({ code, nameEn })),
      callingCodes: callingCodes(c.idd),
      drivingSide: LEFT_HAND.has(c.cca2) ? 'left' : 'right',
    };
  }
  return countries;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const res = await fetch(URL_JSON);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const countries = convert(await res.json());
  const n = Object.keys(countries).length;
  if (n < 200) throw new Error(`Only ${n} countries, refusing to write`);
  const out = { source: URL_JSON, fetchedAt: new Date().toISOString().slice(0, 10), countries };
  writeFileSync(OUT, JSON.stringify(out) + '\n');
  console.log(`Wrote ${n} countries to ${OUT}`);
}
